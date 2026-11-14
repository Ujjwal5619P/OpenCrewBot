import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { LibSQLStore } from "@mastra/libsql";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
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
const { approvalPolicyForTool } = require(resolve("src/lib/server/approval-core.ts"));

const storage = new LibSQLStore({ id: "approval-controller-test", url: `file:${join(process.argv[2], "mastra.db")}` });
let calls = 0;
let callId = 0;
const actionTool = createTool({
  id: "test_action",
  description: "Deterministic side effect used by approval tests.",
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => {
    calls += 1;
    return `executed:${value}`;
  },
});
const model = new MastraLanguageModelV2Mock({
  provider: "mock",
  modelId: "approval-test-model",
  doStream: async ({ prompt }) => {
    const id = `approval-tool-${++callId}`;
    if (prompt.some((message) => message.role === "tool")) {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "final" });
            controller.enqueue({ type: "text-delta", id: "final", delta: "Done." });
            controller.enqueue({ type: "text-end", id: "final" });
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            controller.close();
          },
        }),
      };
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName: "test_action",
            input: JSON.stringify({ value: id }),
          });
          controller.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
          controller.close();
        },
      }),
    };
  },
});

async function harness(name, mode, permissions = []) {
  const agent = new Agent({
    id: `agent-${name}`,
    name,
    instructions: "Call test_action once.",
    model,
    tools: { test_action: actionTool },
  });
  const controller = new AgentController({
    id: `controller-${name}`,
    agent,
    storage,
    modes: [{ id: "chat", name: "Chat", metadata: { default: true } }],
    toolCategoryResolver: () => "other",
  });
  await controller.init();
  const session = await controller.createSession({
    resourceId: "test-owner",
    scope: name,
    threadId: `thread-${name}`,
  });
  await session.permissions.setForCategory({ category: "other", policy: "ask" });
  await session.permissions.setForTool({
    toolName: "test_action",
    policy: approvalPolicyForTool(mode, permissions, "test_action", "other"),
  });
  return { controller, session };
}

function timeout(promise, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), 10_000);
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

async function runScenario(name, mode, permissions, decision) {
  const { controller, session } = await harness(name, mode, permissions);
  let resolveApproval;
  let resolveToolEnd;
  const approvalEvent = new Promise((resolvePromise) => { resolveApproval = resolvePromise; });
  const toolEndEvent = new Promise((resolvePromise) => { resolveToolEnd = resolvePromise; });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_approval_required") resolveApproval(event);
    if (event.type === "tool_end") resolveToolEnd(event);
  });
  const before = calls;
  const send = session.sendMessage({ content: "Run the action now." });
  let requested = false;
  if (decision) {
    const request = await timeout(approvalEvent, `${name}: approval was not requested`);
    requested = true;
    if (calls !== before) throw new Error(`${name}: action executed before approval`);
    const result = await session.respondToToolApproval({ toolCallId: request.toolCallId, decision });
    if (!result.accepted) throw new Error(`${name}: Mastra did not accept the approval decision`);
  }
  await timeout(send, `${name}: agent turn did not finish`);
  if (!requested) await timeout(toolEndEvent, `${name}: tool did not finish`);
  unsubscribe();
  await controller.destroy();
  return { requested, executed: calls - before };
}

async function main() {
  const askApproved = await runScenario("ask-approved", "ask", [], "approve");
  const askRejected = await runScenario("ask-rejected", "ask", [], "decline");
  const controlledAllowed = await runScenario("controlled-allowed", "controlled", ["test_action"]);
  const controlledUnconfigured = await runScenario("controlled-unconfigured", "controlled", [], "decline");
  const full = await runScenario("full", "full", []);
  await storage.close();
  process.stdout.write(JSON.stringify({ askApproved, askRejected, controlledAllowed, controlledUnconfigured, full }));
}

main().catch(async (error) => {
  console.error(error);
  try { await storage.close(); } catch {}
  process.exitCode = 1;
});
