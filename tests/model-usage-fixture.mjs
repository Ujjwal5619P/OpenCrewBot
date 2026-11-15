import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const store = require(resolve("src/lib/server/db.ts"));
const bot = {
  id: "multi-model-bot",
  name: "Model Bot",
  handle: "model-bot",
  title: "Test",
  description: "Test provider persistence.",
  instructions: "",
  emoji: "🤖",
  color: "#3b82f6",
  model: "qwen3:latest",
  modelProvider: "ollama",
  fallbackModel: { providerId: "nebius", model: "org/fallback" },
  modelRouting: { research: { providerId: "ollama", model: "qwen3:latest" } },
  tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
  connections: [],
  approval: "ask",
  pinned: false,
  createdAt: new Date().toISOString(),
};

async function close() {
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
}

if (process.argv[3] === "write") {
  await store.saveBot(bot);
  await store.saveMessage({
    id: "unknown-usage-message",
    conversationId: "dm:multi-model-bot",
    role: "bot",
    botId: bot.id,
    createdAt: new Date().toISOString(),
    status: "done",
    parts: [],
    model: bot.model,
    usage: {
      input: null,
      output: null,
      costUsd: null,
      provider: "ollama",
      model: bot.model,
      requestedAt: new Date().toISOString(),
      simulated: false,
    },
  });
  await store.saveMessage({
    id: "legacy-mock-message",
    conversationId: "dm:legacy",
    role: "bot",
    botId: "legacy-bot",
    createdAt: "2000-01-01T00:00:00.000Z",
    status: "done",
    parts: [],
    model: "mock",
    usage: { input: 120, output: 40, costUsd: null },
  });
  const { createBot } = require(resolve("src/lib/server/service.ts"));
  let credentialRejected = false;
  try {
    await createBot({ ...bot, apiKey: "must-not-be-persisted" });
  } catch (error) {
    credentialRejected = error instanceof Error && error.message.includes("configured on the server");
  }
  if (!credentialRejected) throw new Error("Bot creation accepted a provider credential.");
  await close();
  process.stdout.write(JSON.stringify({ credentialRejected }));
} else {
  const persistedBot = await store.getBot(bot.id);
  const usage = (await store.modelUsageSummary()).find((row) => row.provider === "ollama");
  const legacy = (await store.listMessages("dm:legacy"))[0];
  await close();
  process.stdout.write(JSON.stringify({
    bot: {
      provider: persistedBot.modelProvider,
      model: persistedBot.model,
      fallbackModel: persistedBot.fallbackModel,
      researchModel: persistedBot.modelRouting.research,
    },
    usage: {
      provider: usage.provider,
      model: usage.model,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      unknownInputRequests: usage.unknownInputRequests,
      unknownOutputRequests: usage.unknownOutputRequests,
      unknownCostRequests: usage.unknownCostRequests,
      simulatedRequests: usage.simulatedRequests,
      fallbackRequests: usage.fallbackRequests,
    },
    legacyMockUsage: legacy.usage,
  }));
}
