import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  AgentConfigurationError,
  agentConfigurationToBotInput,
  simulatedAgentConfiguration,
  validateAgentConfiguration,
} from "../src/lib/server/agent-config.ts";

const availableTools = { webSearch: true, memory: true, codeMode: true, browser: true, askUser: true };
const model = { id: "MiniMaxAI/MiniMax-M3", tools: true };

test("validates configurations, model availability, memory consistency, and duplicate skills", () => {
  const generated = simulatedAgentConfiguration(
    "Create a cybersecurity research agent that remembers findings and produces structured reports.",
    model.id,
  );
  assert.equal(validateAgentConfiguration(generated, { models: [model], availableTools }).configuration.approval, "ask");
  const unavailable = validateAgentConfiguration(generated, {
    models: [model],
    availableTools: { ...availableTools, webSearch: false, browser: false },
  });
  assert.equal(unavailable.configuration.tools.webSearch, false);
  assert.deepEqual(unavailable.unavailableTools, ["webSearch"]);
  const input = agentConfigurationToBotInput(generated);
  assert.match(input.instructions, /## Specialist skills/);
  assert.match(input.instructions, /## Expected output format/);
  assert.throws(() => validateAgentConfiguration({ ...generated, model: "invented/model" }, { models: [model], availableTools }), AgentConfigurationError);
  assert.throws(() => validateAgentConfiguration({ ...generated, approval: "full" }, { models: [model], availableTools }), AgentConfigurationError);
  assert.throws(
    () => validateAgentConfiguration({ ...generated, tools: { ...generated.tools, memory: false } }, { models: [model], availableTools }),
    /Memory configuration must match/,
  );
  assert.throws(
    () =>
      validateAgentConfiguration(
        { ...generated, skills: ["Research", "research"] },
        { models: [model], availableTools },
      ),
    /Duplicate skill/,
  );
});

test("persists a generated bot, creates private memory, and uses it through runTurn", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-agent-"));
  const fixture = fileURLToPath(new URL("./agent-creation-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      found: true,
      memoryCreated: true,
      turnStatus: "done",
      mockReply: true,
      simulatedUsage: {
        provider: "mock",
        model: "scripted-mock",
        input: null,
        output: null,
        costUsd: null,
        simulated: true,
      },
      generationMode: "simulated",
      explicitSimulationLabel: true,
      approval: "ask",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
