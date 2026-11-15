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

const catalog = require(resolve("src/lib/server/skills/catalog.ts"));
const { reusableSkillTools } = require(resolve("src/lib/server/skills/tools.ts"));
const approval = require(resolve("src/lib/server/approval-core.ts"));
const { toolCategory } = require(resolve("src/lib/server/tools.ts"));
const composio = require(resolve("src/lib/server/composio.ts"));
const { isMock } = require(resolve("src/lib/server/config.ts"));
const service = require(resolve("src/lib/server/service.ts"));
const store = require(resolve("src/lib/server/db.ts"));

const hiddenValue = "mcp-token-that-must-not-leak";
const schemas = {
  action: {
    toolSlug: "GITHUB_SEARCH_REPOSITORIES",
    toolkit: "github",
    description: "Search repositories",
    inputSchema: { token: hiddenValue },
  },
  other: { toolSlug: "GMAIL_SEND_EMAIL", toolkit: "gmail", description: "Wrong toolkit" },
};

const disconnected = composio.formatToolDiscoveryResult("github", {
  success: true,
  toolkitConnectionStatuses: [{ toolkit: "github", hasActiveConnection: false }],
  toolSchemas: schemas,
});
const connected = composio.formatToolDiscoveryResult("github", {
  success: true,
  toolkitConnectionStatuses: [{ toolkit: "github", hasActiveConnection: true }],
  toolSchemas: schemas,
});
const failed = composio.formatToolDiscoveryResult("github", {
  success: false,
  toolkitConnectionStatuses: [],
  toolSchemas: schemas,
  error: hiddenValue,
});

const skillToolset = reusableSkillTools(["email-drafting"], new Set(["COMPOSIO_MULTI_EXECUTE_TOOL"]));

delete process.env.COMPOSIO_API_KEY;
delete process.env.NEBIUS_API_KEY;
const unavailable = await composio.discoverAppTools("github", "search repositories");
const createdBot = await service.createBot({
  name: "Skill Agent",
  title: "Test",
  description: "Validates persistent skill assignment.",
  instructions: "",
  emoji: "🤖",
  color: "#3b82f6",
  model: "test-model",
  tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
  connections: [],
  skillIds: ["email-drafting"],
  approval: "ask",
  pinned: false,
});
const persistedSkillIds = (await store.getBot(createdBot.id)).skillIds;
let invalidSkillAssignmentRejected = false;
try {
  await service.updateBot(createdBot.id, { skillIds: ["not-a-skill"] });
} catch {
  invalidSkillAssignmentRejected = true;
}
await store.saveBot({ ...createdBot, skillIds: undefined });
const legacySkillIds = (await store.getBot(createdBot.id)).skillIds;

process.stdout.write(JSON.stringify({
  skillIds: catalog.SKILLS.map((skill) => skill.id),
  skillValidation: {
    malformed: (() => {
      try {
        catalog.validateSkillDefinitions([{ id: "bad skill" }]);
        return false;
      } catch (error) {
        return String(error.message).includes("Invalid skill definition");
      }
    })(),
    duplicate: (() => {
      try {
        catalog.validateSkillDefinitions([catalog.SKILLS[0], catalog.SKILLS[0]]);
        return false;
      } catch (error) {
        return String(error.message).includes("Duplicate skill ID");
      }
    })(),
    unknownAssignment: (() => {
      try {
        catalog.validateSkillIds(["not-a-skill"]);
        return false;
      } catch {
        return true;
      }
    })(),
  },
  missingToolLoad: catalog.loadSkill("market-research", ["market-research"], new Set(["web_search"])),
  unassignedLoad: catalog.loadSkill("market-research", [], new Set(["web_search", "read_page"])),
  loaded: catalog.loadSkill("market-research", ["market-research"], new Set(["web_search", "read_page"])),
  discovered: catalog.discoverSkills(["market-research"], new Set(["web_search", "read_page"])),
  skillToolNames: Object.keys(skillToolset).sort(),
  skillToolCategory: toolCategory("skill_load"),
  assignmentPersistence: { persistedSkillIds, invalidSkillAssignmentRejected, legacySkillIds },
  permissionPolicies: {
    ask: approval.approvalPolicyForTool("ask", [], "COMPOSIO_MULTI_EXECUTE_TOOL", "mcp"),
    controlled: approval.approvalPolicyForTool("controlled", ["COMPOSIO_MULTI_EXECUTE_TOOL"], "COMPOSIO_MULTI_EXECUTE_TOOL", "mcp"),
    full: approval.approvalPolicyForTool("full", [], "COMPOSIO_MULTI_EXECUTE_TOOL", "mcp"),
    controlledCodeTools: Object.keys(
      approval.toolsAllowedInCodeMode(
        { skill_load: {}, COMPOSIO_MULTI_EXECUTE_TOOL: {} },
        "controlled",
        ["COMPOSIO_MULTI_EXECUTE_TOOL"],
        toolCategory,
      ),
    ),
  },
  integrationDiscovery: { disconnected, connected, failed, unavailable, mockMode: isMock() },
}));
