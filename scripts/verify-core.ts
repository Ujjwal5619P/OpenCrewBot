import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate all database + workspace writes for core verification inside a temp dir.
const TEMP_DATA = mkdtempSync(join(tmpdir(), "opencrewbot-verify-"));
process.env.OPENCREWBOT_DATA_DIR = TEMP_DATA;
delete process.env.NEBIUS_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.BROWSERBASE_API_KEY;
delete process.env.COMPOSIO_API_KEY;

async function main() {
  const { boot } = await import("../src/lib/server/service");
  const db = await import("../src/lib/server/db");
  const config = await import("../src/lib/server/config");
  const delegation = await import("../src/lib/server/delegation");
  const memoryFiles = await import("../src/lib/server/memory-files");
  const promptMod = await import("../src/lib/server/prompt");
  const runtime = await import("../src/lib/server/runtime");
  const tools = await import("../src/lib/server/tools");
  const skills = await import("../src/lib/server/skills");
  const csv = await import("../src/lib/server/csv");
  const connectors = await import("../src/lib/server/connectors");
  const github = await import("../src/lib/server/github");
  const service = await import("../src/lib/server/service");

  const results: Array<{ name: string; status: "PASS" | "FAIL"; detail: string }> = [];
  const runCase = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      results.push({ name, status: "PASS", detail: "verified" });
      console.log(`PASS: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      results.push({ name, status: "FAIL", detail: msg });
      console.error(`FAIL: ${name} -> ${msg}`);
      process.exitCode = 1;
    }
  };

  await runCase("1. Workforce seeding & ollama/qwen2.5:3b defaults", async () => {
    await boot();
    const bots = await db.listBots();
    const allRooms = await db.listRooms();
    assert.equal(bots.length, 8, `Expected 8 bots, got ${bots.length}`);
    assert.equal(allRooms.length, 4, `Expected 4 rooms, got ${allRooms.length}`);

    for (const expectedName of ["Scout", "Quill", "Atlas", "Analyst", "Growth", "Engineer", "Finance", "Ops"]) {
      assert.ok(bots.some((b) => b.name === expectedName), `Missing bot ${expectedName}`);
    }
    for (const b of bots) {
      assert.equal(b.model, "ollama/qwen2.5:3b", `Bot ${b.name} should default to ollama/qwen2.5:3b`);
    }
    const studio = allRooms.find((r) => r.name === "Studio")!;
    const growth = bots.find((b) => b.name === "Growth")!;
    assert.ok(studio.memberIds.includes(growth.id), "Studio must include Growth");
    for (const r of allRooms) {
      assert.equal(new Set(r.memberIds).size, r.memberIds.length, `Duplicate members in ${r.name}`);
      assert.ok(r.leadId && r.memberIds.includes(r.leadId), `Invalid leadId in ${r.name}`);
    }
  });

  await runCase("2. Delegation validation: membership, missing ID, missing tasks, placeholders, cycles", async () => {
    const bots = await db.listBots();
    const allRooms = await db.listRooms();
    const prodEng = allRooms.find((r) => r.name === "Product & Engineering")!;
    const prodMembers = bots.filter((b) => prodEng.memberIds.includes(b.id));

    // A. Reject Analyst / Quill in Product & Engineering
    assert.throws(
      () =>
        delegation.validateDelegationPlan(
          { tasks: [{ title: "Analyze", instructions: "Run metrics", assignee: "@analyst" }] },
          prodEng,
          prodMembers,
          bots,
        ),
      /not a member of room "Product & Engineering"/i,
    );
    assert.throws(
      () =>
        delegation.validateDelegationPlan(
          { tasks: [{ title: "Write copy", instructions: "Draft notes", assignee: "Quill" }] },
          prodEng,
          prodMembers,
          bots,
        ),
      /not a member of room "Product & Engineering"/i,
    );

    // B. Auto-generate task IDs when omitted (even through DelegationToolInputSchema first)
    const toolParsed = delegation.DelegationToolInputSchema.parse({
      tasks: [
        { title: "Step 1", instructions: "Check logs", assignee: "@ops" },
        { title: "Step 2", instructions: "Patch bug", assignee: "@engineer", dependsOn: ["task_1"] },
      ],
    });
    const resolved = delegation.validateDelegationPlan(toolParsed, prodEng, prodMembers, bots);
    assert.deepEqual(
      resolved.map((t) => t.id),
      ["task_1", "task_2"],
    );

    // C. Missing tasks array rejected cleanly
    assert.throws(() => delegation.validateDelegationPlan({}, prodEng, prodMembers, bots), /non-empty `tasks` array/i);
    assert.throws(() => delegation.DelegationToolInputSchema.parse({}), /Invalid input|expected array/i);

    // D. Unknown & placeholder assignees rejected
    for (const bad of ["Jenny", "DevTeam1", "DevTeam2", "agent_1"]) {
      assert.throws(
        () =>
          delegation.validateDelegationPlan(
            { tasks: [{ title: "Do work", instructions: "Run", assignee: bad }] },
            prodEng,
            prodMembers,
            bots,
          ),
        /Invalid placeholder assignee|Cannot identify room member/i,
      );
    }

    // E. Self-dependency & circular dependency rejected
    assert.throws(
      () =>
        delegation.validateDelegationPlan(
          { tasks: [{ id: "a", title: "A", instructions: "X", assignee: "@engineer", dependsOn: ["a"] }] },
          prodEng,
          prodMembers,
          bots,
        ),
      /Self-referential dependency/i,
    );
    assert.throws(
      () =>
        delegation.validateDelegationPlan(
          {
            tasks: [
              { id: "a", title: "A", instructions: "X", assignee: "@engineer", dependsOn: ["b"] },
              { id: "b", title: "B", instructions: "Y", assignee: "@ops", dependsOn: ["a"] },
            ],
          },
          prodEng,
          prodMembers,
          bots,
        ),
      /Circular dependency detected/i,
    );
  });

  await runCase("3. Parallel DAG execution, dependency passing, SQLite persistence, blocked & recovery paths", async () => {
    const bots = await db.listBots();
    const allRooms = await db.listRooms();
    // Market Intelligence members: Scout, Atlas, Analyst, Ops
    const marketRoom = allRooms.find((r) => r.name === "Market Intelligence")!;
    const members = bots.filter((b) => marketRoom.memberIds.includes(b.id));
    const lead = members.find((b) => b.name === "Scout")!;

    const resolved = delegation.validateDelegationPlan(
      {
        tasks: [
          { title: "Research India EdTech", instructions: "Collect drivers", assignee: "@scout" },
          { title: "Analyze CAC/ROAS", instructions: "Analyze campaign CSV", assignee: "@analyst" },
          {
            title: "Build Strategic Roadmap",
            instructions: "Synthesize inputs",
            assignee: "@atlas",
            dependsOn: ["task_1", "task_2"],
          },
        ],
      },
      marketRoom,
      members,
      bots,
    );

    const seenPrompts: Record<string, string> = {};
    const report = await delegation.executeDelegationPlan({
      room: marketRoom,
      conversationId: `room:${marketRoom.id}`,
      tasks: resolved,
      requestedBy: lead,
      isStopped: () => false,
      onPersist: db.saveDelegationRun,
      runWorkerTurn: async ({ bot, content }) => {
        seenPrompts[bot.name] = content;
        return {
          id: `msg-${bot.id}`,
          conversationId: `room:${marketRoom.id}`,
          role: "bot",
          botId: bot.id,
          createdAt: new Date().toISOString(),
          status: "done",
          model: "ollama/qwen2.5:3b",
          parts: [{ kind: "text", text: `Output from ${bot.name}` }],
        };
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.summary.completed, 3);
    assert.ok(seenPrompts["Atlas"].includes("Output from Scout"), "Downstream task must receive task_1 output");
    assert.ok(seenPrompts["Atlas"].includes("Output from Analyst"), "Downstream task must receive task_2 output");

    const savedRuns = await db.listDelegationRuns(marketRoom.id, 5);
    assert.ok(savedRuns.some((r) => r.id === report.runId && r.ok === true && r.tasks.every((t) => t.outcome === "completed")));

    // Failure -> blocked downstream AND recovery via fallbackAssignee
    const failPlan = delegation.validateDelegationPlan(
      {
        tasks: [
          { id: "p1", title: "Fail task", instructions: "Fail cleanly", assignee: "@scout" },
          { id: "p2", title: "Depends on fail", instructions: "Wait", assignee: "@analyst", dependsOn: ["p1"] },
          {
            id: "r1",
            title: "Recoverable task",
            instructions: "Try fallback",
            assignee: "@ops",
            fallbackAssignee: "@atlas",
          },
        ],
      },
      marketRoom,
      members,
      bots,
    );
    const failReport = await delegation.executeDelegationPlan({
      room: marketRoom,
      conversationId: `room:${marketRoom.id}`,
      tasks: failPlan,
      requestedBy: lead,
      isStopped: () => false,
      onPersist: db.saveDelegationRun,
      runWorkerTurn: async ({ bot }) => {
        if (bot.name === "Scout" || bot.name === "Ops") {
          return {
            id: `err-${bot.id}`,
            conversationId: `room:${marketRoom.id}`,
            role: "bot",
            botId: bot.id,
            createdAt: new Date().toISOString(),
            status: "error",
            error: "Simulated worker failure",
            parts: [],
          };
        }
        return {
          id: `ok-${bot.id}`,
          conversationId: `room:${marketRoom.id}`,
          role: "bot",
          botId: bot.id,
          createdAt: new Date().toISOString(),
          status: "done",
          parts: [{ kind: "text", text: `Recovered by ${bot.name}` }],
        };
      },
    });
    assert.equal(failReport.ok, false);
    assert.equal(failReport.partial, true);
    assert.equal(failReport.tasks.find((t) => t.id === "p1")?.outcome, "failed");
    assert.equal(failReport.tasks.find((t) => t.id === "p2")?.outcome, "blocked");
    const recovered = failReport.tasks.find((t) => t.id === "r1");
    assert.equal(recovered?.outcome, "completed");
    assert.equal(recovered?.recoveredFrom?.botName, "Ops");
    assert.equal(recovered?.botName, "Atlas");
  });

  await runCase("4. Memory isolation (bot private MEMORY.md + shared room MEMORY.md)", async () => {
    const bots = await db.listBots();
    const allRooms = await db.listRooms();
    const scout = bots.find((b) => b.name === "Scout")!;
    const analyst = bots.find((b) => b.name === "Analyst")!;
    const marketRoom = allRooms.find((r) => r.name === "Market Intelligence")!;

    memoryFiles.appendMemory(scout.id, "Our target audience is Class 11 students in India.", "Audience");
    memoryFiles.appendRoomMemory(marketRoom.id, "Shared Q3 KPI: Focus on Class 11 India JEE/NEET cohorts.", "KPI");

    const scoutPrompt = promptMod.systemPrompt(scout, [], []);
    const analystPrompt = promptMod.systemPrompt(analyst, [], []);
    const roomMem = memoryFiles.roomMemoryForPrompt(marketRoom.id);

    assert.ok(scoutPrompt.includes("Our target audience is Class 11 students in India."), "Scout prompt loads private memory");
    assert.ok(!analystPrompt.includes("Our target audience is Class 11 students in India."), "Analyst prompt stays isolated from Scout private memory");
    assert.ok(roomMem.text.includes("Shared Q3 KPI: Focus on Class 11 India JEE/NEET cohorts."), "Shared room MEMORY.md loads saved content");
  });

  await runCase("5. Permission matrix & permanently blocking rejected approval replays", async () => {
    assert.equal(tools.toolCategory("read_csv"), "read");
    assert.equal(tools.toolCategory("memory_add"), "edit");
    assert.equal(tools.toolCategory("room_memory_add"), "edit");
    assert.equal(tools.toolCategory("browser_click"), "execute");
    assert.equal(tools.toolCategory("mcp_1_search"), "read");
    assert.equal(tools.toolCategory("mcp_1_create_issue"), "mcp");
    assert.equal(tools.toolCategory("COMPOSIO_GMAIL_SEND_EMAIL"), "mcp");

    const bots = await db.listBots();
    const ops = bots.find((b) => b.name === "Ops")!;
    const convId = `dm:${ops.id}` as const;
    const callId = "call-reject-test-001";
    await db.saveMessage({
      id: "msg-approval-test",
      conversationId: convId,
      role: "bot",
      botId: ops.id,
      createdAt: new Date().toISOString(),
      status: "streaming",
      parts: [
        {
          kind: "tool",
          toolCallId: callId,
          name: "browser_navigate",
          label: "Browser: navigate",
          status: "awaiting-approval",
          detail: "https://example.com",
        },
      ],
    });

    const pending = await runtime.listPendingApprovals();
    assert.ok(pending.some((p) => p.toolCallId === callId), "Pending approval must appear in Approval Centre list");

    await runtime.respondToApproval(convId, ops.id, callId, false);
    const afterReject = await db.findToolPartByCallId(convId, callId);
    assert.equal(afterReject?.status, "denied", "Rejected tool part must be persisted as denied");

    // Replaying approval MUST be permanently rejected!
    await assert.rejects(() => runtime.respondToApproval(convId, ops.id, callId, true), /permanently blocked from executing/i);
  });

  await runCase("6. CSV strictness & missing value counting", async () => {
    const sample = csv.analyzeCsvFile("samples/meetuniversity_campaigns.csv");
    assert.equal(sample.totals.revenue, 2621900);
    assert.equal(sample.totals.cost, 885000);
    assert.equal(sample.totals.profit, 1736900);

    const saved = csv.saveUploadedCsv(
      "test_missing.csv",
      "campaign,channel,revenue,cost,leads\nSpring,Search,10000,2000,50\nSummer,,8000,,40\n",
    );
    assert.equal(saved.report.dataQuality.missingValueCount, 2);
    assert.throws(() => csv.saveUploadedCsv("bad.bin", "\u0000\u0001binary"), /appears to be binary/i);
    assert.throws(() => csv.saveUploadedCsv("empty.csv", ""), /empty/i);
  });

  await runCase("7. Local Ollama pipeline: OpenAI-compatible runtime check + honest default localhost detection", async () => {
    // First check default 127.0.0.1:11434 inside cloud container
    const defaultAvailable = await config.isOllamaReachable(true);
    assert.equal(typeof defaultAvailable, "boolean");
    assert.equal(config.isMock(), !defaultAvailable);

    // Spin up an ephemeral local OpenAI-compatible mock Ollama server to prove
    // real Mastra + providerId:"ollama" streaming works without "mock" fallback when reachable!
    const server = createServer((req, res) => {
      if (req.url === "/api/tags" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen2.5:3b" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk1 = {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "qwen2.5:3b",
          choices: [{ index: 0, delta: { role: "assistant", content: "Ollama live pipeline verified." }, finish_reason: null }],
        };
        const chunk2 = {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "qwen2.5:3b",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const prevUrl = process.env.OLLAMA_BASE_URL;
    try {
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
      const liveAvailable = await config.isOllamaReachable(true);
      assert.equal(liveAvailable, true);
      assert.equal(config.isMock(), false);

      const bots = await db.listBots();
      const scout = bots.find((b) => b.name === "Scout")!;
      const reply = await runtime.runTurn({
        bot: scout,
        conversationId: `dm:${scout.id}`,
        content: "Ping test",
      });
      assert.ok(reply, "Expected bot reply");
      assert.equal(reply.status, "done");
      assert.equal(reply.model, "ollama/qwen2.5:3b", `Expected live Ollama model tag, got ${reply.model}`);
      const text = reply.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
      assert.ok(text.includes("Ollama live pipeline verified."), `Unexpected text: ${text}`);
    } finally {
      if (prevUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = prevUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await config.isOllamaReachable(true).catch(() => {});
    }
  });

  await runCase("8. Truthfulness of Market Research & Competitor Analysis when Tavily unset", async () => {
    const mr = await skills.runSkill("market-research", {
      market: "Class 11 STEM coaching in India",
      region: "India",
      segment: "Class 11",
    });
    assert.equal(mr.deliverable.liveResearchAvailable, false);
    assert.deepEqual(mr.deliverable.sources, []);

    const ca = await skills.runSkill("competitor-analysis", {
      product: "MeetUniversity",
      competitors: ["Collegedunia", "Shiksha"],
    });
    assert.equal(ca.deliverable.liveResearchAvailable, false);
    assert.deepEqual(ca.deliverable.sources, []);
    assert.ok(!ca.markdown.includes("http://") && !ca.markdown.includes("https://"), "Must not fabricate URLs");
  });

  await runCase("9. GitHub repo listing tool, strict schemas, permissions, pagination & circuit breaker", async () => {
    const bots = await db.listBots();
    const quill = bots.find((b) => b.name === "Quill")!;
    const engineer = bots.find((b) => b.name === "Engineer")!;
    const scout = bots.find((b) => b.name === "Scout")!;

    // A. github_repos_list MUST NOT be registered as a reusable skill
    assert.ok(!skills.listSkills().some((s) => s.id === "github_repos_list"), "github_repos_list must not be a skill");
    await assert.rejects(() => skills.runSkill("github_repos_list", {}), /Unknown skill "github_repos_list"/i);

    // B. Strict run_skill schema rejects missing skillId or github_repos_list
    const builtTools = tools.buildTools(engineer).tools as Record<string, { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } }>;
    assert.equal(tools.toolCategory("github_repos_list"), "read");
    assert.equal(builtTools.run_skill.inputSchema?.safeParse({}).success, false);
    assert.equal(builtTools.run_skill.inputSchema?.safeParse({ skillId: "github_repos_list" }).success, false);
    assert.equal(builtTools.run_skill.inputSchema?.safeParse({ skillId: "code-review", unexpected: true }).success, false);

    // C. Bots without GitHub permission must NOT receive github_repos_list
    const quillConn = await connectors.buildConnectorTools(quill, "test-quill");
    assert.equal("github_repos_list" in quillConn.tools, false);
    await assert.rejects(
      () => github.listGithubRepositories(quill, { visibility: "all", perPage: 30, page: 1 }),
      /GitHub is not enabled for Quill/i,
    );
    await quillConn.close();

    // D. Grant github:env permission to Engineer; verify strict schema & missing credentials error
    const updatedEngineer = await service.updateBot(engineer.id, { connections: ["github:env"] });
    const engConn = await connectors.buildConnectorTools(updatedEngineer, "test-eng");
    assert.equal("github_repos_list" in engConn.tools, true, "Engineer with github:env permission must receive github_repos_list");
    await engConn.close();

    assert.throws(
      () => github.parseGithubReposListInput({}),
      /Invalid arguments for github_repos_list/i,
    );
    assert.throws(
      () => github.parseGithubReposListInput({ visibility: "all", perPage: 30, page: 1, unexpected: "foo" }),
      /Invalid arguments for github_repos_list/i,
    );

    const prevToken = process.env.GITHUB_TOKEN;
    const prevApiUrl = process.env.GITHUB_API_URL;
    delete process.env.GITHUB_TOKEN;
    await assert.rejects(
      () => github.listGithubRepositories(updatedEngineer, { visibility: "all", perPage: 30, page: 1 }),
      /GitHub is not connected/i,
    );

    // E. Isolated mock GitHub REST API verifying auth header, /user status, multi-page Link pagination, & 401
    let port = 0;
    const ghServer = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth !== "Bearer gh_test_valid_token") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }
      const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (reqUrl.pathname === "/user") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-OAuth-Scopes": "repo, read:user",
        });
        res.end(JSON.stringify({ login: "opencrew-tester" }));
        return;
      }
      if (reqUrl.pathname === "/user/repos") {
        const page = Number(reqUrl.searchParams.get("page") || "1");
        if (page === 1) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            Link: `<http://127.0.0.1:${port}/user/repos?visibility=all&per_page=2&page=2>; rel="next"`,
          });
          res.end(
            JSON.stringify([
              {
                name: "public-portal",
                full_name: "opencrew-tester/public-portal",
                description: "Public web portal",
                private: false,
                default_branch: "main",
                html_url: "https://github.com/opencrew-tester/public-portal",
              },
              {
                name: "private-core",
                full_name: "opencrew-tester/private-core",
                description: "Private engine",
                private: true,
                default_branch: "develop",
                html_url: "https://github.com/opencrew-tester/private-core",
              },
            ]),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              name: "infra-scripts",
              full_name: "opencrew-tester/infra-scripts",
              description: null,
              private: true,
              default_branch: "main",
              html_url: "https://github.com/opencrew-tester/infra-scripts",
            },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => ghServer.listen(0, "127.0.0.1", () => resolve()));
    const ghAddr = ghServer.address();
    port = typeof ghAddr === "object" && ghAddr ? ghAddr.port : 0;

    try {
      process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;
      process.env.GITHUB_TOKEN = "gh_test_valid_token";

      const status = await github.getWorkspaceGithubStatus(true);
      assert.equal(status.configured, true);
      assert.equal(status.source, "env");
      assert.equal(status.login, "opencrew-tester");
      assert.deepEqual(status.scopes, ["repo", "read:user"]);

      const singlePage = await github.listGithubRepositories(updatedEngineer, {
        visibility: "all",
        perPage: 2,
        page: 1,
        allPages: false,
      });
      assert.equal(singlePage.totalCount, 2);
      assert.equal(singlePage.hasNextPage, true);
      assert.equal(singlePage.nextPage, 2);

      const allPages = await github.listGithubRepositories(updatedEngineer, {
        visibility: "all",
        perPage: 2,
        page: 1,
        allPages: true,
      });
      assert.equal(allPages.pagesFetched, 2);
      assert.equal(allPages.totalCount, 3);
      assert.equal(allPages.hasNextPage, false);
      assert.equal(allPages.repositories[1].visibility, "private");
      assert.equal(allPages.repositories[1].private, true);
      assert.equal(allPages.repositories[1].default_branch, "develop");
      assert.equal(allPages.repositories[1].html_url, "https://github.com/opencrew-tester/private-core");

      process.env.GITHUB_TOKEN = "gh_invalid_token";
      await assert.rejects(
        () => github.listGithubRepositories(updatedEngineer, { visibility: "all", perPage: 2, page: 1 }),
        /401 Unauthorized/i,
      );
    } finally {
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevToken;
      if (prevApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = prevApiUrl;
      await new Promise<void>((resolve) => ghServer.close(() => resolve()));
      await service.updateBot(engineer.id, { connections: [] });
    }

    // F. Repeated invalid tool-call circuit breaker stops looping Ollama calls well before 90s
    let callCounter = 0;
    const loopOllama = createServer((req, res) => {
      if (req.url === "/api/tags" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen2.5:3b" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        callCounter += 1;
        const callId = `call_loop_${callCounter}`;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk1 = {
          id: `chatcmpl-loop-${callCounter}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "qwen2.5:3b",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "run_skill", arguments: "{}" } }],
              },
              finish_reason: null,
            },
          ],
        };
        const chunk2 = {
          id: `chatcmpl-loop-${callCounter}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "qwen2.5:3b",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => loopOllama.listen(0, "127.0.0.1", () => resolve()));
    const loopAddr = loopOllama.address();
    const loopPort = typeof loopAddr === "object" && loopAddr ? loopAddr.port : 0;
    const prevOllamaUrl = process.env.OLLAMA_BASE_URL;
    const started = Date.now();
    try {
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${loopPort}`;
      await config.isOllamaReachable(true);
      const reply = await runtime.runTurn({
        bot: scout,
        conversationId: `dm:${scout.id}`,
        content: "Trigger repeated invalid tool call check",
      });
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs < 15_000, `Circuit breaker took too long: ${elapsedMs}ms`);
      assert.ok(reply, "Expected aborted turn message");
      assert.equal(reply.status, "error");
      assert.match(reply.error ?? "", /Stopped repeated failing tool call|maximum steps/i);
    } finally {
      if (prevOllamaUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = prevOllamaUrl;
      await new Promise<void>((resolve) => loopOllama.close(() => resolve()));
      await config.isOllamaReachable(true).catch(() => {});
    }
  });

  console.log(`\nCore verification complete: ${results.filter((r) => r.status === "PASS").length}/${results.length} passed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      rmSync(TEMP_DATA, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });
