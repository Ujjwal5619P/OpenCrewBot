import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { costUsd, listModelCatalog, mastraModelFor, selectModelForBot } from "../src/lib/server/models.ts";
import {
  AgentConfigurationError,
  agentConfigurationToBotInput,
  simulatedAgentConfiguration,
  validateAgentConfiguration,
} from "../src/lib/server/agent-config.ts";

const tools = { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false };
const availableNebius = {
  id: "org/neb-model",
  label: "Nebius model",
  provider: "org",
  providerId: "nebius",
  context: 16_000,
  tools: true,
  reasoning: false,
  vision: false,
  inputPerM: 1,
  outputPerM: 2,
  live: true,
  available: true,
};
const availableOllama = {
  ...availableNebius,
  id: "qwen3:latest",
  label: "qwen3 latest",
  provider: "qwen3",
  providerId: "ollama",
  inputPerM: null,
  outputPerM: null,
};
const catalog = {
  models: [availableNebius, availableOllama],
  providers: [
    { providerId: "nebius", label: "Nebius Token Factory", available: true, configured: true },
    { providerId: "ollama", label: "Ollama", available: true, configured: true },
  ],
};

function bot(overrides = {}) {
  return {
    id: "bot",
    model: "org/neb-model",
    modelProvider: "nebius",
    tools,
    ...overrides,
  };
}

test("resolves per-agent defaults and task-specific model routes", () => {
  const configured = bot({ modelRouting: { research: { providerId: "ollama", model: "qwen3:latest" } } });
  const general = selectModelForBot(configured, "general", catalog);
  const research = selectModelForBot(configured, "research", catalog);
  assert.deepEqual([general.providerId, general.model, general.simulated], ["nebius", "org/neb-model", false]);
  assert.deepEqual([research.providerId, research.model, research.simulated], ["ollama", "qwen3:latest", false]);
});

test("validates and stores provider/model pairs during agent configuration", () => {
  const generated = simulatedAgentConfiguration("Create a writing agent.", "qwen3:latest", "ollama");
  const validated = validateAgentConfiguration(generated, {
    models: [availableOllama],
    availableTools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: true },
  });
  assert.equal(validated.configuration.modelProvider, "ollama");
  assert.equal(agentConfigurationToBotInput(validated.configuration).modelProvider, "ollama");
  assert.throws(
    () => validateAgentConfiguration({ ...generated, modelProvider: "nebius" }, {
      models: [availableOllama],
      availableTools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: true },
    }),
    AgentConfigurationError,
  );
});

test("uses only an explicit available fallback before model execution", () => {
  const configured = bot({
    modelProvider: "nebius",
    model: "missing/model",
    fallbackModel: { providerId: "ollama", model: "qwen3:latest" },
  });
  const resolution = selectModelForBot(configured, "coding", catalog);
  assert.deepEqual(resolution.fallbackFrom, { providerId: "nebius", model: "missing/model" });
  assert.equal(resolution.providerId, "ollama");
  assert.throws(
    () => selectModelForBot(bot({ model: "missing/model" }), "general", catalog),
    /unavailable/,
  );
  assert.throws(
    () => selectModelForBot(bot({
      model: "missing/model",
      fallbackModel: { providerId: "ollama", model: "not-installed" },
    }), "general", catalog),
    /fallback model.*unavailable/,
  );
});

test("labels missing Nebius as simulated and leaves unavailable Ollama explicit", () => {
  const noNebius = {
    models: [{ ...availableNebius, available: false }],
    providers: [
      { providerId: "nebius", label: "Nebius Token Factory", available: false, configured: false },
      { providerId: "ollama", label: "Ollama", available: false, configured: true },
    ],
  };
  const mock = selectModelForBot(bot(), "general", noNebius);
  assert.deepEqual([mock.providerId, mock.simulated], ["mock", true]);
  assert.throws(
    () => selectModelForBot(bot({ modelProvider: "ollama", model: "qwen3:latest" }), "general", noNebius),
    /unavailable/,
  );
  assert.equal(costUsd(availableOllama, 100, 50), null);
});

test("discovers Ollama models and tool capability through a deterministic local mock", async () => {
  const previousUrl = process.env.OLLAMA_BASE_URL;
  const previousKey = process.env.NEBIUS_API_KEY;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "qwen3:latest", details: { family: "qwen3" } }] }));
    } else if (request.url === "/api/show") {
      response.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "qwen3.context_length": 32768 } }));
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.NEBIUS_API_KEY = "";
  delete process.env.NEBIUS_API_KEY;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
  try {
    const discovered = await listModelCatalog(true);
    const ollama = discovered.models.find((model) => model.providerId === "ollama" && model.id === "qwen3:latest");
    assert.equal(discovered.providers.find((provider) => provider.providerId === "ollama")?.available, true);
    assert.deepEqual([ollama?.available, ollama?.tools, ollama?.context], [true, true, 32768]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEBIUS_API_KEY;
    else process.env.NEBIUS_API_KEY = previousKey;
  }
});

test("uses Mastra's OpenAI-compatible router without exposing the configured key in telemetry", () => {
  const previousUrl = process.env.OLLAMA_BASE_URL;
  const previousKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.OLLAMA_API_KEY = "test-secret-not-for-telemetry";
  try {
    const model = mastraModelFor({ providerId: "ollama", model: "qwen3:latest" });
    const serialized = JSON.stringify(model.serializeForSpan());
    assert.doesNotMatch(serialized, /test-secret-not-for-telemetry/);
    assert.equal(model.modelId, "qwen3:latest");
  } finally {
    if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousKey;
  }
});

test("persists provider preferences and unknown usage across process restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-model-usage-"));
  const fixture = fileURLToPath(new URL("./model-usage-fixture.mjs", import.meta.url));
  try {
    const write = spawnSync(process.execPath, [fixture, directory, "write"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(write.status, 0, write.stderr || write.stdout);
    assert.deepEqual(JSON.parse(write.stdout), { credentialRejected: true });
    const read = spawnSync(process.execPath, [fixture, directory, "read"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(read.status, 0, read.stderr || read.stdout);
    const result = JSON.parse(read.stdout);
    assert.deepEqual(result.bot, {
      provider: "ollama",
      model: "qwen3:latest",
      fallbackModel: { providerId: "nebius", model: "org/fallback" },
      researchModel: { providerId: "ollama", model: "qwen3:latest" },
    });
    assert.deepEqual(result.usage, {
      provider: "ollama",
      model: "qwen3:latest",
      requests: 1,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      unknownInputRequests: 1,
      unknownOutputRequests: 1,
      unknownCostRequests: 1,
      simulatedRequests: 0,
      fallbackRequests: 0,
    });
    assert.deepEqual(result.legacyMockUsage, {
      input: null,
      output: null,
      costUsd: null,
      provider: "mock",
      model: "scripted-mock",
      requestedAt: "2000-01-01T00:00:00.000Z",
      simulated: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not switch to fallback or repeat a completed tool after a later model failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-model-fallback-"));
  const fixture = fileURLToPath(new URL("./multi-model-fallback-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(
      { status: observed.status, provider: observed.provider, model: observed.model, fallbackUsed: observed.fallbackUsed, noteCount: observed.noteCount },
      { status: "error", provider: "ollama", model: "primary:latest", fallbackUsed: false, noteCount: 1 },
    );
    assert.ok(observed.requestedModels.length >= 2);
    assert.ok(observed.requestedModels.every((model) => model === "primary:latest"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
