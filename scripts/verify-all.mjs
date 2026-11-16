import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.OPENCREWBOT_TEST_URL || "http://127.0.0.1:3000";

async function jsonReq(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

async function pollUntilIdle(conversationId, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await jsonReq(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    assert.equal(res.status, 200);
    if (Array.isArray(res.json.running) && res.json.running.length === 0) {
      return res.json.messages;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${conversationId} to finish running`);
}

async function main() {
  console.log("=== Part 1: Isolated Server Core Verification ===");
  execFileSync(process.execPath, ["scripts/run-ts.cjs", "scripts/verify-core.ts"], { stdio: "inherit" });

  console.log("\n=== Part 2: Live HTTP & API Verification against " + BASE + " ===");

  // 1. Landing HTML loads cleanly
  const home = await fetch(BASE);
  assert.equal(home.status, 200, "Root page must respond HTTP 200");
  const html = await home.text();
  assert.ok(html.includes("OpenCrewBot"), "HTML should render OpenCrewBot title/content");
  console.log("PASS: Live HTML / responds HTTP 200");

  // 2. Bootstrap state check
  const bootRes = await jsonReq("/api/bootstrap");
  assert.equal(bootRes.status, 200);
  const { status, bots, rooms } = bootRes.json;
  assert.equal(bots.length, 8, `Expected 8 bots, got ${bots.length}`);
  assert.equal(rooms.length, 4, `Expected 4 rooms, got ${rooms.length}`);
  assert.equal(status.keys.nebius, false);
  for (const b of bots) {
    assert.equal(b.model, "ollama/qwen2.5:3b", `${b.name} expected ollama/qwen2.5:3b`);
  }
  console.log(
    `PASS: /api/bootstrap (${bots.length} bots, ${rooms.length} rooms, ollamaAvailable=${status.ollama.available}, mock=${status.mock})`,
  );

  // 3. Connections optionality (including GitHub status)
  const connRes = await jsonReq("/api/connections");
  assert.equal(connRes.status, 200);
  assert.equal(connRes.json.composio.enabled, false);
  assert.equal(connRes.json.github.configured, false);
  assert.equal(connRes.json.github.source, "none");
  console.log("PASS: /api/connections works without COMPOSIO_API_KEY or GITHUB_TOKEN");

  // Verify github_repos_list is not registered as a skill and missing skillId fails cleanly
  const skillsListRes = await jsonReq("/api/skills");
  assert.equal(skillsListRes.status, 200);
  assert.equal(skillsListRes.json.skills.length, 8);
  assert.equal(skillsListRes.json.skills.some((s) => s.id === "github_repos_list"), false);
  const badSkill = await jsonReq("/api/skills/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: "github_repos_list" }),
  });
  assert.equal(badSkill.status, 400);

  // 4. All 8 skills via HTTP
  const skillCases = [
    ["market-research", { market: "Indian study abroad prep", region: "India", segment: "Class 11" }],
    ["competitor-analysis", { product: "MeetUniversity", competitors: ["Shiksha", "Collegedunia"] }],
    [
      "financial-modelling",
      {
        price: 4500,
        grossMarginPct: 75,
        monthlyLeads: 1000,
        conversionRatePct: 12,
        marketingSpend: 500000,
        fixedOpsCost: 40000,
        budgetAllocation: { searchPct: 40, socialPct: 30, eventsPct: 20, emailPct: 10 },
      },
    ],
    ["presentation-creation", { topic: "MeetUniversity Q4 Plan", audience: "Leadership", slides: 6 }],
    ["email-drafting", { recipient: "Admissions Lead", goal: "Q4 Enrollment Push", tone: "Executive" }],
    ["code-review", { filename: "handler.ts", code: "const q = `SELECT * FROM users WHERE id = ${req.id}`; console.log(q);" }],
    ["data-analysis", { csvPath: "samples/meetuniversity_campaigns.csv" }],
    ["lead-generation", { product: "Study Abroad Counseling", targetLeads: 1500, primaryChannels: ["Search", "Webinars"] }],
  ];
  for (const [skillId, input] of skillCases) {
    const r = await jsonReq("/api/skills/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId, input }),
    });
    assert.equal(r.status, 200, `Skill ${skillId} HTTP error: ${JSON.stringify(r.json)}`);
    assert.ok(r.json.result.markdown.length > 40, `Skill ${skillId} empty markdown`);
    if (skillId === "market-research" || skillId === "competitor-analysis") {
      assert.equal(r.json.result.deliverable.liveResearchAvailable, false);
      assert.deepEqual(r.json.result.deliverable.sources, []);
    }
  }
  const badFin = await jsonReq("/api/skills/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skillId: "financial-modelling",
      input: {
        price: 4500,
        grossMarginPct: 75,
        monthlyLeads: 1000,
        conversionRatePct: 8,
        marketingSpend: 100000,
        budgetAllocation: { searchPct: 50, socialPct: 50, eventsPct: 20, emailPct: 0 },
      },
    }),
  });
  assert.equal(badFin.status, 400, "Budget not summing to 100% must fail HTTP 400");
  console.log("PASS: All 8 skills verified via /api/skills/run + strict non-skill rejection + financial validation");

  // 5. CSV sample analysis + multipart upload + cleanup
  const csvSample = await jsonReq("/api/csv?path=samples/meetuniversity_campaigns.csv");
  assert.equal(csvSample.status, 200);
  assert.equal(csvSample.json.report.totals.revenue, 2621900);
  assert.equal(csvSample.json.report.totals.cost, 885000);
  assert.equal(csvSample.json.report.totals.profit, 1736900);

  const form = new FormData();
  form.append(
    "file",
    new Blob(["campaign,channel,revenue,cost,leads\nTestA,Search,50000,10000,120\nTestB,,25000,,40\n"], { type: "text/csv" }),
    "verify_upload.csv",
  );
  const uploadRes = await jsonReq("/api/csv", { method: "POST", body: form });
  assert.equal(uploadRes.status, 201, `CSV upload failed: ${JSON.stringify(uploadRes.json)}`);
  assert.equal(uploadRes.json.report.dataQuality.missingValueCount, 2);
  const uploadedRel = uploadRes.json.path;
  if (uploadedRel && existsSync(resolve(process.cwd(), uploadedRel))) {
    unlinkSync(resolve(process.cwd(), uploadedRel));
  }

  const badForm = new FormData();
  badForm.append("file", new Blob(["\u0000\u0001not-csv"], { type: "application/octet-stream" }), "bad.bin");
  const badUpload = await jsonReq("/api/csv", { method: "POST", body: badForm });
  assert.equal(badUpload.status, 400);
  console.log("PASS: CSV analysis, multipart upload missing-value audit, and invalid file rejection");

  // 6. Bot & Room Memory API persistence + clean restore
  const scout = bots.find((b) => b.name === "Scout");
  const marketRoom = rooms.find((r) => r.name === "Market Intelligence");
  const origScoutMem = (await jsonReq(`/api/bots/${scout.id}/memory`)).json.content;
  const origRoomMem = (await jsonReq(`/api/rooms/${marketRoom.id}/memory`)).json.content;
  try {
    const sentinel = "Our target audience is Class 11 students in India.";
    await jsonReq(`/api/bots/${scout.id}/memory`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `${origScoutMem.trimEnd()}\n- ${sentinel}\n` }),
    });
    await jsonReq(`/api/rooms/${marketRoom.id}/memory`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `${origRoomMem.trimEnd()}\n- ${sentinel}\n` }),
    });
    const scoutCheck = await jsonReq(`/api/bots/${scout.id}/memory`);
    const roomCheck = await jsonReq(`/api/rooms/${marketRoom.id}/memory`);
    assert.ok(scoutCheck.json.content.includes(sentinel));
    assert.ok(roomCheck.json.content.includes(sentinel));
  } finally {
    await jsonReq(`/api/bots/${scout.id}/memory`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: origScoutMem }),
    });
    await jsonReq(`/api/rooms/${marketRoom.id}/memory`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: origRoomMem }),
    });
  }
  console.log("PASS: Bot private MEMORY.md & shared room MEMORY.md API read/write");

  // 7. Approval Centre API check
  const approvalsRes = await jsonReq("/api/approvals");
  assert.equal(approvalsRes.status, 200);
  assert.ok(Array.isArray(approvalsRes.json.approvals));
  console.log("PASS: /api/approvals returns structured pending list");

  // 8. Scheduler CRUD + Edit + Manual Run + Cleanup
  const schedCreate = await jsonReq("/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Verify Workflow",
      target: { kind: "dm", botId: scout.id },
      prompt: "Summarize readiness check cleanly.",
      recurrence: "daily",
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
      enabled: true,
      maxRetries: 2,
    }),
  });
  assert.equal(schedCreate.status, 200);
  const schedId = schedCreate.json.schedule.id;
  try {
    const schedPatch = await jsonReq(`/api/schedules/${schedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Verify Workflow Edited", maxRetries: 3 }),
    });
    assert.equal(schedPatch.status, 200);
    assert.equal(schedPatch.json.schedule.name, "Verify Workflow Edited");
    assert.equal(schedPatch.json.schedule.maxRetries, 3);

    const runRes = await jsonReq(`/api/schedules/${schedId}/run`, { method: "POST" });
    assert.equal(runRes.status, 200);
    assert.equal(runRes.json.run.status, "success");
    await jsonReq(`/api/conversations/${encodeURIComponent(`dm:${scout.id}`)}/clear`, { method: "POST" });
  } finally {
    await jsonReq(`/api/schedules/${schedId}`, { method: "DELETE" });
  }
  console.log("PASS: Scheduler CRUD, Edit (PATCH), Execution, and Delete");

  // 9. Direct chat + Room delegation via HTTP + clean clear
  const dmConv = `dm:${scout.id}`;
  const sendDm = await jsonReq(`/api/conversations/${encodeURIComponent(dmConv)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Quick verification ping" }),
  });
  assert.equal(sendDm.status, 200);
  const dmMsgs = await pollUntilIdle(dmConv);
  assert.ok(dmMsgs.some((m) => m.role === "bot" && m.status === "done"), "Direct bot reply must finish");
  await jsonReq(`/api/conversations/${encodeURIComponent(dmConv)}/clear`, { method: "POST" });

  const roomConv = `room:${marketRoom.id}`;
  const sendRoom = await jsonReq(`/api/conversations/${encodeURIComponent(roomConv)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Run full Q3 campaign research with @scout delegating to @analyst" }),
  });
  assert.equal(sendRoom.status, 200);
  const roomMsgs = await pollUntilIdle(roomConv);
  assert.ok(roomMsgs.some((m) => m.role === "bot"), "Room reply must finish");
  await jsonReq(`/api/conversations/${encodeURIComponent(roomConv)}/clear`, { method: "POST" });
  console.log("PASS: Live direct messaging & room conversation execution");

  console.log("\nALL VERIFICATION CHECKS PASSED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
