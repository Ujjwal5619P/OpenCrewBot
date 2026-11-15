import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("reusable skills and Composio integrations remain validated and permission-bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-module-f-"));
  const fixture = fileURLToPath(new URL("./module-f-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.skillIds, [
      "market-research",
      "competitor-analysis",
      "financial-modelling",
      "presentation-creation",
      "email-drafting",
      "code-review",
      "data-analysis",
      "lead-generation",
    ]);
    assert.deepEqual(value.skillValidation, { malformed: true, duplicate: true, unknownAssignment: true });
    assert.deepEqual(value.missingToolLoad, {
      status: "unavailable",
      name: "Market Research",
      missingTools: ["read_page"],
    });
    assert.equal(value.unassignedLoad.status, "not_assigned");
    assert.equal(value.loaded.status, "loaded");
    assert.match(value.loaded.skill.instructions, /cite URLs/i);
    assert.equal(value.discovered.length, 8);
    assert.equal(value.discovered.find((skill) => skill.id === "market-research").assigned, true);
    assert.deepEqual(value.skillToolNames, ["skill_discover", "skill_load"]);
    assert.equal(value.skillToolCategory, "read");
    assert.deepEqual(value.assignmentPersistence, {
      persistedSkillIds: ["email-drafting"],
      invalidSkillAssignmentRejected: true,
      legacySkillIds: [],
    });
    assert.deepEqual(value.permissionPolicies, {
      ask: "ask",
      controlled: "ask",
      full: "allow",
      controlledCodeTools: ["skill_load"],
    });

    const integrations = value.integrationDiscovery;
    assert.equal(integrations.disconnected.status, "disconnected");
    assert.equal(integrations.connected.status, "connected");
    assert.equal(integrations.failed.status, "error");
    assert.equal(integrations.unavailable.status, "unavailable");
    assert.equal(integrations.mockMode, true);
    assert.match(integrations.unavailable.message, /COMPOSIO_API_KEY/);
    assert.deepEqual(integrations.unavailable.tools, []);
    assert.deepEqual(integrations.disconnected.tools.map((tool) => tool.toolSlug), ["GITHUB_SEARCH_REPOSITORIES"]);
    assert.doesNotMatch(JSON.stringify(integrations), /mcp-token-that-must-not-leak/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
