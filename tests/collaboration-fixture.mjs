import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
process.env.NEBIUS_API_KEY = "";
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  const resolved = request.startsWith("@/") ? resolve("src", request.slice(2)) : request;
  return originalResolveFilename.call(this, resolved, parent, ...args);
};
const originalLoad = Module._load;
const calls = [];
let active = 0;
let peak = 0;
let buildToolsForTest;
Module._load = function (request, parent, isMain) {
  if (request === "./runtime" && parent?.filename.endsWith("execution-service.ts")) {
    return {
      runTurn: async ({ bot, conversationId, content, onProgress }) => {
        const title = content.match(/^\[OpenCrewBot task: (.+)\]$/m)?.[1] ?? "unknown";
        const dependencies = content.includes("Completed dependency outputs:");
        if (title === "Hang") return new Promise(() => {});
        calls.push({ type: "started", title, dependencies, dependencyOutput: content.includes("### Research\nResearch output") });
        active += 1;
        peak = Math.max(peak, active);
        const delay = title === "Research" ? 30 : 15;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
        active -= 1;
        calls.push({ type: "completed", title });
        const text = title === "Review" ? "VERDICT: ACCEPTED\nSources agree." : `${title} output`;
        const questionId = content.match(/Question message ID: ([a-zA-Z0-9-]+)/)?.[1];
        if (questionId && buildToolsForTest) {
          await buildToolsForTest(bot).tools.room_collaborate.execute(
            { type: "answer", responseToMessageId: questionId, content: "I validated it." },
            { agent: { threadId: `${conversationId}:${bot.id}:0` }, abortSignal: new AbortController().signal },
          );
        }
        const message = {
          id: `message-${title}-${Date.now()}`,
          conversationId,
          role: "bot",
          botId: bot.id,
          createdAt: new Date().toISOString(),
          status: "done",
          parts: [{ kind: "text", text }],
        };
        onProgress?.(message);
        return message;
      },
      stopConversation: async () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
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

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitForExecution(store, id, expectedStatus) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const execution = await store.getExecution(id);
    if (execution?.status === expectedStatus) return execution;
    await delay(10);
  }
  throw new Error(`Execution ${id} did not reach ${expectedStatus}.`);
}

async function main() {
  const store = require(resolve("src/lib/server/db.ts"));
  const { buildTools } = require(resolve("src/lib/server/tools.ts"));
  buildToolsForTest = buildTools;
  const { cancelExecution } = require(resolve("src/lib/server/execution-service.ts"));
  const now = new Date().toISOString();
  const bot = (id, name) => ({
    id, name, handle: id, title: name, description: "", instructions: "", emoji: "x", color: "#000000",
    model: "test-model", tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
    connections: [], approval: "ask", pinned: false, createdAt: now,
  });
  const agents = [bot("bot-a", "Atlas"), bot("bot-b", "Scout"), bot("bot-c", "Reviewer")];
  for (const agent of agents) await store.saveBot(agent);
  await store.saveRoom({
    id: "room-a", name: "Test room", topic: "", emoji: "x", memberIds: agents.map((agent) => agent.id),
    leadId: "bot-a", responder: "lead", pinned: false, createdAt: now,
  });
  const rootTools = buildTools(agents[0]).tools;
  const invoke = (tool, threadId, input) => tool.execute(input, { agent: { threadId }, abortSignal: new AbortController().signal });
  const plan = [
    { id: "research", title: "Research", objective: "Find current sources", context: "Focus on the last year", expectedOutput: "A sourced summary", assignedBotId: "bot-b", dependencies: [] },
    { id: "draft", title: "Draft", objective: "Write a concise summary", context: "Use the room request", expectedOutput: "A short draft", assignedBotId: "bot-c", dependencies: [] },
    { id: "review", title: "Review", objective: "Verify the research", context: "Check source support", expectedOutput: "A verdict and rationale", assignedBotId: "bot-c", dependencies: ["research"], verificationOfTaskId: "research" },
  ];
  const created = await invoke(rootTools.delegate_room_work, "room:room-a:bot-a:0", { tasks: plan });
  const completed = await waitForExecution(store, created.executionId, "completed");
  const roomData = await store.listCollaborationMessages("room-a");
  const researchStarted = calls.findIndex((call) => call.type === "started" && call.title === "Research");
  const researchCompleted = calls.findIndex((call) => call.type === "completed" && call.title === "Research");
  const reviewStarted = calls.findIndex((call) => call.type === "started" && call.title === "Review");

  const question = await invoke(rootTools.room_collaborate, "room:room-a:bot-a:0", {
    type: "question", recipientBotId: "bot-b", content: "Can you validate the source?",
  });
  const questionExecution = await waitForExecution(store, question.responseExecutionId, "completed");
  const questionMessages = await store.listCollaborationMessages("room-a");
  let invalidAnswerRejected = false;
  try {
    await invoke(buildTools(agents[2]).tools.room_collaborate, "room:room-a:bot-c:0", {
      type: "answer", responseToMessageId: question.message.id, content: "Not authorized.",
    });
  } catch {
    invalidAnswerRejected = true;
  }

  const loopTask = [{ ...plan[0], dependencies: [], verificationOfTaskId: undefined }];
  const { delegationPattern } = require(resolve("src/lib/server/collaboration-core.ts"));
  const parent = {
    id: "loop-parent", instruction: "loop", summary: "loop", plannerMode: "simulated", plannerLabel: "test",
    status: "running", createdAt: now,
    collaboration: { roomId: "room-a", rootExecutionId: "loop-parent", depth: 1, delegatorBotId: "bot-a", path: [delegationPattern(loopTask, "bot-a")] },
    tasks: [{ id: "parent-task", title: "Parent", description: "Parent", assignedBotId: "bot-a", requiredCapabilities: [], dependencies: [], status: "running", createdAt: now, startedAt: now, retryCount: 0, approvalRequired: true }],
  };
  await store.saveExecution(parent);
  let repeatedRejected = false;
  try {
    await invoke(rootTools.delegate_room_work, "execution:loop-parent:task:parent-task:bot-a:0", { tasks: loopTask });
  } catch {
    repeatedRejected = true;
  }
  let activeRepeatedRejected = false;
  try {
    await invoke(rootTools.delegate_room_work, "room:room-a:bot-a:0", { tasks: loopTask });
  } catch {
    activeRepeatedRejected = true;
  }

  const cancelParent = {
    ...parent,
    id: "cancel-parent",
    collaboration: { ...parent.collaboration, rootExecutionId: "cancel-parent", path: [] },
  };
  await store.saveExecution(cancelParent);
  const child = await invoke(rootTools.delegate_room_work, "execution:cancel-parent:task:parent-task:bot-a:0", {
    tasks: [{ id: "hang", title: "Hang", objective: "Wait", context: "", expectedOutput: "A result", assignedBotId: "bot-b", dependencies: [] }],
  });
  await cancelExecution(cancelParent.id);
  const childResult = await store.getExecution(child.executionId);

  const raceParent = {
    ...cancelParent,
    id: "race-parent",
    collaboration: { ...cancelParent.collaboration, rootExecutionId: "race-parent" },
  };
  await store.saveExecution(raceParent);
  const originalSaveExecution = store.saveExecution;
  let releaseChildSave;
  let notifyChildSaveStarted;
  const childSaveStarted = new Promise((resolvePromise) => {
    notifyChildSaveStarted = resolvePromise;
  });
  const childSaveGate = new Promise((resolvePromise) => {
    releaseChildSave = resolvePromise;
  });
  store.saveExecution = async (execution, messages) => {
    if (execution.collaboration?.parentExecutionId === raceParent.id) {
      notifyChildSaveStarted();
      await childSaveGate;
    }
    return originalSaveExecution(execution, messages);
  };
  const raceController = new AbortController();
  const racingDelegation = rootTools.delegate_room_work.execute(
    {
      tasks: [{
        id: "race-child",
        title: "Racing child",
        objective: "Must not run after parent cancellation",
        context: "",
        expectedOutput: "A result",
        assignedBotId: "bot-b",
        dependencies: [],
      }],
    },
    {
      agent: { threadId: "execution:race-parent:task:parent-task:bot-a:0" },
      abortSignal: raceController.signal,
    },
  );
  await childSaveStarted;
  raceController.abort();
  await cancelExecution(raceParent.id);
  releaseChildSave();
  await racingDelegation.catch(() => {});
  store.saveExecution = originalSaveExecution;
  const raceChildren = await store.listChildExecutions(raceParent.id);
  const persistedRejection = (await store.listCollaborationMessages("room-a")).some((message) =>
    message.type === "delegation_rejected" && message.content.includes("Repeated delegation pattern"),
  );
  const output = {
    executionStatus: completed.status,
    parallelPeak: peak,
    dependencyOutputPassed: calls.some((call) => call.title === "Review" && call.dependencyOutput),
    dependencyWaited: researchStarted >= 0 && researchCompleted >= 0 && reviewStarted > researchCompleted,
    approvalRequired: completed.tasks.every((task) => task.approvalRequired),
    verificationStatus: completed.tasks.find((task) => task.id === "review").collaboration.verificationStatus,
    outputShared: roomData.some((message) => message.type === "task_output" && message.taskId === "research"),
    questionAnswered:
      questionMessages.some((message) => message.type === "answer" && message.responseToMessageId === question.message.id) &&
      questionExecution.tasks[0].status === "completed",
    invalidAnswerRejected,
    repeatedRejected,
    activeRepeatedRejected,
    persistedRejection,
    parentCancellationCancelsChild: childResult.status === "cancelled",
    parentCancellationDuringChildPersistencePreventsLaunch:
      raceChildren.length === 1 &&
      raceChildren[0].status === "cancelled" &&
      !calls.some((call) => call.title === "Racing child"),
  };
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
  process.stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
