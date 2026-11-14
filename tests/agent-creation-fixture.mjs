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

async function main() {
  const { generateAgentConfiguration } = require(resolve("src/lib/server/agent-generation.ts"));
  const { createBot } = require(resolve("src/lib/server/service.ts"));
  const store = require(resolve("src/lib/server/db.ts"));
  const { resetBot, runTurn } = require(resolve("src/lib/server/runtime.ts"));
  const { memoryPath } = require(resolve("src/lib/server/memory-files.ts"));

  const generated = await generateAgentConfiguration("Create a helpful writing agent that remembers preferences.");
  const created = await createBot(generated.botInput);
  const loaded = await store.getBot(created.id);
  const message = await runTurn({
    bot: loaded,
    conversationId: `dm:${created.id}`,
    content: "Hello, introduce yourself.",
  });
  const output = {
    found: loaded?.id === created.id,
    memoryCreated: readFileSync(memoryPath(created.id), "utf8").includes(`# ${created.name}'s memory`),
    turnStatus: message?.status,
    mockReply: message?.parts.some((part) => part.kind === "text" && part.text.includes("mock model")),
    generationMode: generated.mode,
    explicitSimulationLabel: generated.label.includes("Simulated") && generated.label.includes("no AI inference"),
    approval: generated.botInput.approval,
  };
  await resetBot(created.id);
  const runtime = globalThis.__opencrewbotRuntime;
  if (runtime?.storage?.close) await runtime.storage.close();
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
  process.stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
