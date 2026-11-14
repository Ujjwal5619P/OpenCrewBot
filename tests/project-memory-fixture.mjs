import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
delete process.env.NEBIUS_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.BROWSERBASE_API_KEY;

const dataDir = process.argv[2];
const legacyPath = join(dataDir, "workspaces", "legacy-bot", "MEMORY.md");
mkdirSync(resolve(legacyPath, ".."), { recursive: true });
writeFileSync(legacyPath, "# Existing private memory\n\n- Keep this note.\n", "utf8");

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
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

const now = new Date().toISOString();
const bot = (id, name) => ({
  id,
  name,
  handle: id,
  title: "Test agent",
  description: "",
  instructions: "",
  emoji: "x",
  color: "#000000",
  model: "test-model",
  tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
  connections: [],
  approval: "ask",
  pinned: false,
  createdAt: now,
});

async function closeStore(store) {
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
}

async function writeState() {
  const store = require(resolve("src/lib/server/db.ts"));
  const memory = require(resolve("src/lib/server/memory-files.ts"));
  const access = require(resolve("src/lib/server/project-memory.ts"));
  const { buildTools, toolCategory } = require(resolve("src/lib/server/tools.ts"));
  const bots = [bot("agent-a", "Atlas"), bot("agent-b", "Scout")];
  for (const agent of bots) await store.saveBot(agent);
  await access.setAuthorizedProjectMemoryBots(["agent-a"], []);

  memory.writeMemory("agent-a", "# Agent A\n\n- Private note A\n");
  memory.writeMemory("agent-b", "# Agent B\n\n- Private note B\n");
  const initialLegacy = memory.readMemory("legacy-bot");
  memory.writeProjectMemory("# Shared project memory\n\n## Decisions\n- Current baseline _(source: user; confidence: confirmed; date: 2026-11-14)_\n");
  memory.appendProjectMemoryEntry({
    note: "The release freeze is approved.",
    section: "Decisions",
    source: "project_decision",
    confidence: "confirmed",
  });
  const toolsA = buildTools(bots[0]).tools;
  const toolsB = buildTools(bots[1]).tools;
  const toolContext = { agent: { threadId: "dm:agent-a:0" }, abortSignal: new AbortController().signal };
  const readable = await toolsA.project_memory_read.execute({}, toolContext);
  await toolsA.project_memory_add.execute({ note: "This claim still needs independent checking.", section: "Research" }, toolContext);

  const beforeDeniedWrite = memory.readProjectMemory();
  let deniedRead = false;
  let deniedWrite = false;
  try {
    await toolsB.project_memory_read.execute({}, { ...toolContext, agent: { threadId: "dm:agent-b:0" } });
  } catch {
    deniedRead = true;
  }
  try {
    await toolsB.project_memory_add.execute(
      { note: "Unauthorized entry", section: "Research" },
      { ...toolContext, agent: { threadId: "dm:agent-b:0" } },
    );
  } catch {
    deniedWrite = true;
  }

  const unchangedAfterDeniedWrite = memory.readProjectMemory() === beforeDeniedWrite;
  const edited = memory.readProjectMemory().replace("Current baseline", "Updated baseline");
  const secretSamples = [
    "AIzaSyA1234567890abcdefghijklmnopqrstuvwx",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "client_secret=example-client-secret-value",
  ];
  memory.writeProjectMemory(`${edited}\n- api_key=abcdefghijklmno\n- ${secretSamples.join("\n- ")}\n`);
  Module._load = function (request, parent, ...args) {
    if (request === "./service" && parent?.filename.endsWith("http.ts")) return { boot: async () => {} };
    return originalLoad.call(this, request, parent, ...args);
  };
  const projectMemoryRoute = require(resolve("src/app/api/project-memory/route.ts"));
  Module._load = originalLoad;
  const routeWrite = await projectMemoryRoute.PUT(new Request("http://localhost/api/project-memory", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `${memory.readProjectMemory()}\n## UI edits\n- Markdown editor save persisted.\n` }),
  }));
  const routeRead = await projectMemoryRoute.GET();
  const routeSnapshot = await routeRead.json();
  const routeEntry = await projectMemoryRoute.POST(new Request("http://localhost/api/project-memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      note: "The user confirmed the project name.",
      source: "user",
      confidence: "confirmed",
    }),
  }));
  const invalidGrant = await projectMemoryRoute.PATCH(new Request("http://localhost/api/project-memory", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizedBotIds: ["missing-agent"], expectedAuthorizedBotIds: ["agent-a"] }),
  }));
  const staleAccessSave = await projectMemoryRoute.PATCH(new Request("http://localhost/api/project-memory", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizedBotIds: ["agent-b"], expectedAuthorizedBotIds: [] }),
  }));
  const staleSaveDidNotChangeAccess = staleAccessSave.status === 409 &&
    (await access.authorizedProjectMemoryBots()).join(",") === "agent-a";
  const originalThreadId = await access.projectMemoryThreadId("dm:agent-a:0", "agent-a");
  const revokeAccess = await projectMemoryRoute.PATCH(new Request("http://localhost/api/project-memory", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizedBotIds: [], expectedAuthorizedBotIds: ["agent-a"] }),
  }));
  const revokedThreadId = await access.projectMemoryThreadId("dm:agent-a:0", "agent-a");
  const regrantAccess = await projectMemoryRoute.PATCH(new Request("http://localhost/api/project-memory", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizedBotIds: ["agent-a"], expectedAuthorizedBotIds: [] }),
  }));
  const finalMemory = memory.readProjectMemory();
  const saved = {
    privateIsolation:
      memory.readMemory("agent-a").includes("Private note A") &&
      !memory.readMemory("agent-a").includes("Private note B") &&
      memory.readMemory("agent-b").includes("Private note B") &&
      !memory.readMemory("agent-b").includes("Private note A"),
    legacyMemoryPreserved: initialLegacy === "# Existing private memory\n\n- Keep this note.\n" &&
      memory.readMemory("legacy-bot") === initialLegacy,
    authorizedRead: readable.text.includes("Current baseline"),
    deniedRead,
    deniedWrite,
    unauthorizedWriteLeftFileUnchanged: deniedWrite && unchangedAfterDeniedWrite &&
      finalMemory.includes("Updated baseline") &&
      !finalMemory.includes("Unauthorized entry"),
    markdownEditPreservedProvenance:
      finalMemory.includes("Updated baseline _(source: user; confidence: confirmed;") &&
      finalMemory.includes("source: project decision; confidence: confirmed;") &&
      finalMemory.includes("source: agent agent-a; confidence: unverified;"),
    secretsRedacted: ["abcdefghijklmno", ...secretSamples].every((secret) => !finalMemory.includes(secret)),
    commonSecretFormatsRedacted: !finalMemory.includes("AIzaSy") &&
      !finalMemory.includes("github_pat_") &&
      !finalMemory.includes("Bearer ey") &&
      !finalMemory.includes("example-client-secret-value"),
    markdownApiEditAndSave: routeWrite.status === 200 && routeSnapshot.content.includes("Markdown editor save persisted."),
    userEntryProvenance: routeEntry.status === 200 &&
      finalMemory.includes("source: user; confidence: confirmed;") &&
      finalMemory.includes("The user confirmed the project name."),
    invalidGrantRejected: invalidGrant.status === 400,
    staleAccessSaveRejected: staleSaveDidNotChangeAccess,
    revocationRotatesThread: revokeAccess.status === 200 && regrantAccess.status === 200 &&
      originalThreadId === "dm:agent-a:0" &&
      revokedThreadId === "dm:agent-a:0:project-memory-1" &&
      (await access.projectMemoryThreadId("dm:agent-a:0", "agent-a")) === revokedThreadId,
    readToolCategorizedReadOnly: toolCategory("project_memory_read") === "read",
    writeToolCategorizedEdit: toolCategory("project_memory_add") === "edit",
    fixedProjectPath: memory.projectMemoryPath() === resolve(dataDir, "PROJECT_MEMORY.md"),
  };
  await closeStore(store);
  return saved;
}

async function verifyAfterRestart() {
  const store = require(resolve("src/lib/server/db.ts"));
  const memory = require(resolve("src/lib/server/memory-files.ts"));
  const access = require(resolve("src/lib/server/project-memory.ts"));
  const text = memory.readProjectMemory();
  const result = {
    sharedMarkdownPersisted: text.includes("Updated baseline") && text.includes("release freeze"),
    authorizationPersisted: await access.canAccessProjectMemory("agent-a") &&
      !(await access.canAccessProjectMemory("agent-b")),
    accessGenerationPersisted:
      (await access.projectMemoryThreadId("dm:agent-a:0", "agent-a")) === "dm:agent-a:0:project-memory-1",
    privateFilesPersistedIndependently:
      memory.readMemory("agent-a").includes("Private note A") &&
      memory.readMemory("agent-b").includes("Private note B") &&
      memory.readMemory("legacy-bot").includes("Keep this note"),
  };
  await closeStore(store);
  return result;
}

async function main() {
  const result = process.argv[3] === "verify" ? await verifyAfterRestart() : await writeState();
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
