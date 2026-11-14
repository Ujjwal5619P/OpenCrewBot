import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
const require = createRequire(import.meta.url);
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
const makeRequest = (toolCallId, expiresAt = new Date(Date.now() + 60_000).toISOString()) => ({
  id: `request-${toolCallId}`,
  conversationId: "dm:test-bot",
  botId: "test-bot",
  messageId: `message-${toolCallId}`,
  toolCallId,
  toolName: "browser_click",
  action: "Click button",
  details: '{"element":"Submit"}',
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt,
});

async function close() {
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
}

async function writeState() {
  const approved = makeRequest("approved");
  await store.createApprovalRequest(approved);
  const firstDecision = await store.decideApprovalRequest(approved.conversationId, approved.botId, approved.toolCallId, true);
  const duplicateDecision = await store.decideApprovalRequest(approved.conversationId, approved.botId, approved.toolCallId, false);

  const rejected = makeRequest("rejected");
  await store.createApprovalRequest(rejected);
  const rejectedDecision = await store.decideApprovalRequest(rejected.conversationId, rejected.botId, rejected.toolCallId, false);

  const failed = makeRequest("failed");
  await store.createApprovalRequest(failed);
  await store.decideApprovalRequest(failed.conversationId, failed.botId, failed.toolCallId, true);
  await store.failApprovalResume(failed.conversationId, failed.botId, failed.toolCallId);

  const unknown = makeRequest("unknown");
  await store.createApprovalRequest(unknown);
  await store.decideApprovalRequest(unknown.conversationId, unknown.botId, unknown.toolCallId, true);
  await store.markApprovalOutcomeUnknown(unknown.conversationId, unknown.botId, unknown.toolCallId);

  const cancelled = makeRequest("cancelled");
  await store.createApprovalRequest(cancelled);
  await store.cancelApprovalRequest(cancelled.conversationId, cancelled.botId, cancelled.toolCallId, "test");
  const cancelledDecision = await store.decideApprovalRequest(cancelled.conversationId, cancelled.botId, cancelled.toolCallId, true);

  const expired = makeRequest("expired", new Date(Date.now() - 60_000).toISOString());
  await store.createApprovalRequest(expired);
  const expiredDecision = await store.decideApprovalRequest(expired.conversationId, expired.botId, expired.toolCallId, true);

  const interrupted = makeRequest("interrupted");
  await store.createApprovalRequest(interrupted);
  await close();
  return {
    firstDecision: firstDecision.request.status,
    duplicateReason: duplicateDecision.reason,
    rejected: rejectedDecision.request.status,
    resumeFailure: (await store.getApprovalRequest(failed.conversationId, failed.botId, failed.toolCallId)).status,
    unknownOutcome: (await store.getApprovalRequest(unknown.conversationId, unknown.botId, unknown.toolCallId)).status,
    cancelledReason: cancelledDecision.reason,
    expiredReason: expiredDecision.reason,
  };
}

async function verifyAfterRestart() {
  await store.cancelPendingApprovalRequests("server-restart");
  const requests = await store.listApprovalRequests();
  const client = await store.db();
  const migration = await client.execute("SELECT MAX(version) AS version FROM schema_migrations");
  await close();
  return {
    statuses: Object.fromEntries(requests.map((request) => [request.toolCallId, request.status])),
    schemaVersion: Number(migration.rows[0].version),
  };
}

const result = process.argv[3] === "verify" ? await verifyAfterRestart() : await writeState();
process.stdout.write(JSON.stringify(result));
