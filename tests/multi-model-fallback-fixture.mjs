import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
delete process.env.NEBIUS_API_KEY;
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

const requestedModels = [];
let primaryRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/api/tags") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ models: [{ name: "primary:latest" }, { name: "fallback:latest" }] }));
    return;
  }
  if (request.url === "/api/show") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ capabilities: ["completion", "tools"] }));
    return;
  }
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404);
    response.end("{}");
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const model = JSON.parse(body).model;
    requestedModels.push(model);
    if (model === "primary:latest" && primaryRequests++ === 0) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(`data: ${JSON.stringify({
        id: "first",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{
            index: 0,
            id: "memory-call",
            type: "function",
            function: { name: "memory_add", arguments: JSON.stringify({ note: "fallback must not duplicate" }) },
          }] },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "first",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    if (model === "primary:latest") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "simulated post-tool model failure" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      id: "fallback",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: "fallback response" }, finish_reason: null }],
    })}\n\ndata: [DONE]\n\n`);
  });
});

async function main() {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
  const store = require(resolve("src/lib/server/db.ts"));
  const { runTurn, resetBot } = require(resolve("src/lib/server/runtime.ts"));
  const { memoryPath } = require(resolve("src/lib/server/memory-files.ts"));
  const bot = {
    id: "fallback-test",
    name: "Fallback test",
    handle: "fallback-test",
    title: "Test",
    description: "Test fallback boundaries.",
    instructions: "Save the requested note with memory_add, then summarize it.",
    emoji: "bot",
    color: "#3b82f6",
    model: "primary:latest",
    modelProvider: "ollama",
    fallbackModel: { providerId: "ollama", model: "fallback:latest" },
    tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
    connections: [],
    approval: "full",
    approvalPermissions: [],
    pinned: false,
    createdAt: new Date().toISOString(),
  };
  await store.saveBot(bot);
  const message = await runTurn({
    bot,
    conversationId: "dm:fallback-test",
    content: "Remember the exact note: fallback must not duplicate",
  });
  const memory = readFileSync(memoryPath(bot.id), "utf8");
  await resetBot(bot.id);
  const runtime = globalThis.__opencrewbotRuntime;
  if (runtime?.storage?.close) await runtime.storage.close();
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  process.stdout.write(JSON.stringify({
    status: message?.status,
    provider: message?.usage?.provider,
    model: message?.usage?.model,
    fallbackUsed: Boolean(message?.usage?.fallbackFrom),
    requestedModels,
    noteCount: memory.split("fallback must not duplicate").length - 1,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
