// App storage: bots, rooms, and the chat transcript the UI shows. Mastra keeps
// its own store (mastra.db) for each bot's model-facing thread history.
import { createClient, type Client } from "@libsql/client";
import { APP_DB_URL } from "./config";
import type {
  Bot,
  ApprovalRequest,
  ApprovalRequestStatus,
  ChatMessage,
  CollaborationMessage,
  ConversationId,
  Execution,
  ExecutionTask,
  Room,
  ScheduledWorkflow,
  ScheduledWorkflowRun,
} from "@/lib/shared/types";
import { isSkillId } from "./skills/catalog";

// Cached across hot reloads, together with the file it points at, so a
// changed database path opens a fresh connection instead of reusing one
// bound to a file that has moved.
const g = globalThis as unknown as { __opencrewbotDb?: { url: string; schema?: number; client: Promise<Client> } };

/** Bump when a table is added, so a hot-reloaded server re-runs the CREATE statements. */
const SCHEMA_VERSION = 6;

async function open(): Promise<Client> {
  const db = createClient({ url: APP_DB_URL });
  await db.batch(
    [
      "CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, created_at)",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0,
        last_read_at TEXT
      )`,
    ],
    "write",
  );
  await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  await db.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)", [new Date().toISOString()]);
  const versionRows = await db.execute("SELECT MAX(version) AS version FROM schema_migrations");
  const version = Number(versionRows.rows[0]?.version ?? 0);
  if (version < 3) {
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS executions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          data TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS execution_tasks (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL,
          FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
        )`,
        "CREATE INDEX IF NOT EXISTS executions_by_created_at ON executions (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS execution_tasks_by_execution ON execution_tasks (execution_id, created_at)",
        { sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)", args: [new Date().toISOString()] },
      ],
      "write",
    );
  }
  if (version < 4) {
    const columns = await db.execute("PRAGMA table_info(executions)");
    if (!columns.rows.some((row) => String(row.name) === "room_id")) {
      await db.execute("ALTER TABLE executions ADD COLUMN room_id TEXT");
    }
    if (!columns.rows.some((row) => String(row.name) === "parent_execution_id")) {
      await db.execute("ALTER TABLE executions ADD COLUMN parent_execution_id TEXT");
    }
    if (!columns.rows.some((row) => String(row.name) === "pattern_key")) {
      await db.execute("ALTER TABLE executions ADD COLUMN pattern_key TEXT");
    }
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS collaboration_messages (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          execution_id TEXT,
          type TEXT NOT NULL,
          response_to_id TEXT,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS executions_by_room ON executions (room_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS collaboration_messages_by_room ON collaboration_messages (room_id, created_at)",
      ],
      "write",
    );
    const messageColumns = await db.execute("PRAGMA table_info(collaboration_messages)");
    if (!messageColumns.rows.some((row) => String(row.name) === "type")) {
      await db.execute("ALTER TABLE collaboration_messages ADD COLUMN type TEXT NOT NULL DEFAULT 'research'");
    }
    if (!messageColumns.rows.some((row) => String(row.name) === "response_to_id")) {
      await db.execute("ALTER TABLE collaboration_messages ADD COLUMN response_to_id TEXT");
    }
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS one_collaboration_answer ON collaboration_messages (response_to_id) WHERE response_to_id IS NOT NULL AND type = 'answer'",
    );
    await db.execute("CREATE INDEX IF NOT EXISTS executions_by_parent ON executions (parent_execution_id, status)");
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS one_active_room_delegation_pattern ON executions (room_id, pattern_key) WHERE pattern_key IS NOT NULL AND status IN ('pending', 'running')",
    );
    await db.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)", [new Date().toISOString()]);
  }
  if (version < 5) {
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          action TEXT NOT NULL,
          details TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          decided_at TEXT,
          decision_by TEXT,
          execution_id TEXT,
          task_id TEXT,
          UNIQUE (conversation_id, bot_id, tool_call_id)
        )`,
        "CREATE INDEX IF NOT EXISTS approvals_by_status_and_created ON approval_requests (status, created_at DESC)",
        { sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)", args: [new Date().toISOString()] },
      ],
      "write",
    );
  }
  if (version < 6) {
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS scheduled_workflows (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          next_run_at TEXT,
          updated_at TEXT NOT NULL,
          data TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS scheduled_workflows_by_next_run ON scheduled_workflows (status, next_run_at)",
        `CREATE TABLE IF NOT EXISTS scheduled_workflow_runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          execution_id TEXT,
          status TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL,
          UNIQUE (workflow_id, occurrence_key)
        )`,
        "CREATE INDEX IF NOT EXISTS scheduled_runs_by_workflow ON scheduled_workflow_runs (workflow_id, created_at DESC)",
        "CREATE UNIQUE INDEX IF NOT EXISTS one_active_scheduled_run ON scheduled_workflow_runs (workflow_id) WHERE status IN ('claimed', 'running')",
        { sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)", args: [new Date().toISOString()] },
      ],
      "write",
    );
  }
  return db;
}

export function db(): Promise<Client> {
  const cached = g.__opencrewbotDb;
  if (cached?.url === APP_DB_URL && cached.schema === SCHEMA_VERSION) return cached.client;
  // Close the old connection (an older build cached the bare promise).
  const stale = cached && "client" in cached ? cached.client : (cached as unknown as Promise<Client> | undefined);
  void stale?.then((c) => c.close()).catch(() => {});
  const client = open();
  g.__opencrewbotDb = { url: APP_DB_URL, schema: SCHEMA_VERSION, client };
  return client;
}

// ── settings (small JSON values) ────────────────────────────────────────

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const rows = await (await db()).execute({ sql: "SELECT data FROM settings WHERE key = ?", args: [key] });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as T) : undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO settings (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
    args: [key, JSON.stringify(value)],
  });
}

// ── bots ────────────────────────────────────────────────────────────────

/** Fill in fields added after a bot was saved, so older rows keep working. */
function normalizeBot(raw: Bot): Bot {
  return {
    ...raw,
    connections: raw.connections ?? [],
    approval: raw.approval === "full" || raw.approval === "controlled" ? raw.approval : "ask",
    approvalPermissions: Array.isArray(raw.approvalPermissions)
      ? raw.approvalPermissions.filter((toolName): toolName is string => typeof toolName === "string")
      : [],
    skillIds: Array.isArray(raw.skillIds) ? raw.skillIds.filter(isSkillId) : [],
  };
}

export async function listBots(): Promise<Bot[]> {
  const rows = await (await db()).execute("SELECT data FROM bots");
  return rows.rows
    .map((r) => normalizeBot(JSON.parse(String(r.data)) as Bot))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getBot(id: string): Promise<Bot | null> {
  const rows = await (await db()).execute({ sql: "SELECT data FROM bots WHERE id = ?", args: [id] });
  return rows.rows[0] ? normalizeBot(JSON.parse(String(rows.rows[0].data)) as Bot) : null;
}

export async function saveBot(bot: Bot): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO bots (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    args: [bot.id, JSON.stringify(bot)],
  });
}

export async function deleteBotRow(id: string): Promise<void> {
  await (await db()).execute({ sql: "DELETE FROM bots WHERE id = ?", args: [id] });
}

// ── rooms ───────────────────────────────────────────────────────────────

export async function listRooms(): Promise<Room[]> {
  const rows = await (await db()).execute("SELECT data FROM rooms");
  return rows.rows
    .map((r) => JSON.parse(String(r.data)) as Room)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getRoom(id: string): Promise<Room | null> {
  const rows = await (await db()).execute({ sql: "SELECT data FROM rooms WHERE id = ?", args: [id] });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as Room) : null;
}

export async function saveRoom(room: Room): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO rooms (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    args: [room.id, JSON.stringify(room)],
  });
}

export async function deleteRoomRow(id: string): Promise<void> {
  await (await db()).execute({ sql: "DELETE FROM rooms WHERE id = ?", args: [id] });
}

// ── messages ────────────────────────────────────────────────────────────

export async function saveMessage(message: ChatMessage): Promise<void> {
  await (await db()).execute({
    sql: `INSERT INTO messages (id, conversation_id, created_at, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    args: [message.id, message.conversationId, message.createdAt, JSON.stringify(message)],
  });
}

export async function listMessages(conversationId: ConversationId, limit = 200): Promise<ChatMessage[]> {
  const rows = await (await db()).execute({
    sql: `SELECT data FROM (
            SELECT data, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
          ) ORDER BY created_at ASC`,
    args: [conversationId, limit],
  });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as ChatMessage);
}

export async function clearMessages(conversationId: ConversationId): Promise<void> {
  await (await db()).execute({ sql: "DELETE FROM messages WHERE conversation_id = ?", args: [conversationId] });
}

/** The newest message per conversation, for sidebar previews. */
export async function lastMessages(): Promise<Map<ConversationId, ChatMessage>> {
  const rows = await (await db()).execute(
    `SELECT m.data FROM messages m
     JOIN (SELECT conversation_id, MAX(created_at) AS latest FROM messages GROUP BY conversation_id) l
       ON m.conversation_id = l.conversation_id AND m.created_at = l.latest`,
  );
  const out = new Map<ConversationId, ChatMessage>();
  for (const r of rows.rows) {
    const m = JSON.parse(String(r.data)) as ChatMessage;
    out.set(m.conversationId, m);
  }
  return out;
}

export async function unreadCounts(): Promise<Map<ConversationId, number>> {
  const rows = await (await db()).execute(
    `SELECT m.conversation_id AS id, COUNT(*) AS n FROM messages m
     LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE m.created_at > COALESCE(c.last_read_at, '') AND m.data NOT LIKE '%"role":"user"%'
     GROUP BY m.conversation_id`,
  );
  return new Map(rows.rows.map((r) => [String(r.id), Number(r.n)]));
}

export async function markRead(conversationId: ConversationId): Promise<void> {
  await (await db()).execute({
    sql: `INSERT INTO conversations (id, last_read_at) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    args: [conversationId, new Date().toISOString()],
  });
}

function decodeApprovalRequest(row: Record<string, unknown>): ApprovalRequest {
  const decidedAt = row.decided_at == null ? undefined : String(row.decided_at);
  const decisionBy = row.decision_by == null ? undefined : String(row.decision_by);
  const executionId = row.execution_id == null ? undefined : String(row.execution_id);
  const taskId = row.task_id == null ? undefined : String(row.task_id);
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    botId: String(row.bot_id),
    messageId: String(row.message_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    action: String(row.action),
    details: String(row.details),
    status: String(row.status) as ApprovalRequestStatus,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    ...(decidedAt ? { decidedAt } : {}),
    ...(decisionBy ? { decisionBy } : {}),
    ...(executionId ? { executionId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

const APPROVAL_COLUMNS =
  "id, conversation_id, bot_id, message_id, tool_call_id, tool_name, action, details, status, created_at, expires_at, decided_at, decision_by, execution_id, task_id";

export async function createApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
  const client = await db();
  await client.execute({
    sql: `INSERT OR IGNORE INTO approval_requests
      (id, conversation_id, bot_id, message_id, tool_call_id, tool_name, action, details, status, created_at, expires_at, decided_at, decision_by, execution_id, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      request.id,
      request.conversationId,
      request.botId,
      request.messageId,
      request.toolCallId,
      request.toolName,
      request.action,
      request.details,
      request.status,
      request.createdAt,
      request.expiresAt,
      request.decidedAt ?? null,
      request.decisionBy ?? null,
      request.executionId ?? null,
      request.taskId ?? null,
    ],
  });
  const saved = await getApprovalRequest(request.conversationId, request.botId, request.toolCallId);
  if (!saved) throw new Error("Approval request was not persisted.");
  return saved;
}

export async function getApprovalRequest(
  conversationId: ConversationId,
  botId: string,
  toolCallId: string,
): Promise<ApprovalRequest | null> {
  const rows = await (await db()).execute({
    sql: `SELECT ${APPROVAL_COLUMNS} FROM approval_requests WHERE conversation_id = ? AND bot_id = ? AND tool_call_id = ?`,
    args: [conversationId, botId, toolCallId],
  });
  return rows.rows[0] ? decodeApprovalRequest(rows.rows[0]) : null;
}

export async function decideApprovalRequest(
  conversationId: ConversationId,
  botId: string,
  toolCallId: string,
  approve: boolean,
): Promise<{ request: ApprovalRequest | null; reason?: "not_found" | "already_decided" | "cancelled" | "expired" }> {
  const client = await db();
  const now = new Date().toISOString();
  await client.execute({
    sql: `UPDATE approval_requests
      SET status = 'expired', decided_at = ?, decision_by = 'system:expiration'
      WHERE conversation_id = ? AND bot_id = ? AND tool_call_id = ? AND status = 'pending' AND expires_at <= ?`,
    args: [now, conversationId, botId, toolCallId, now],
  });
  const result = await client.execute({
    sql: `UPDATE approval_requests
      SET status = ?, decided_at = ?, decision_by = 'local-owner'
      WHERE conversation_id = ? AND bot_id = ? AND tool_call_id = ? AND status = 'pending' AND expires_at > ?`,
    args: [approve ? "approved" : "rejected", now, conversationId, botId, toolCallId, now],
  });
  if (result.rowsAffected === 1) {
    return { request: await getApprovalRequest(conversationId, botId, toolCallId) };
  }
  const request = await getApprovalRequest(conversationId, botId, toolCallId);
  if (!request) return { request: null, reason: "not_found" };
  if (request.status === "expired") return { request, reason: "expired" };
  if (request.status === "cancelled") return { request, reason: "cancelled" };
  return { request, reason: "already_decided" };
}

export async function cancelPendingApprovalRequests(
  reason: string,
  conversationId?: ConversationId,
  botId?: string,
): Promise<void> {
  const clauses = ["status = 'pending'"];
  const args: (string | null)[] = [new Date().toISOString(), `system:${reason}`];
  if (conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    args.push(conversationId);
  }
  if (botId !== undefined) {
    clauses.push("bot_id = ?");
    args.push(botId);
  }
  await (await db()).execute({
    sql: `UPDATE approval_requests SET status = 'cancelled', decided_at = ?, decision_by = ? WHERE ${clauses.join(" AND ")}`,
    args,
  });
}

export async function cancelApprovalRequest(
  conversationId: ConversationId,
  botId: string,
  toolCallId: string,
  reason: string,
): Promise<void> {
  await (await db()).execute({
    sql: `UPDATE approval_requests
      SET status = 'cancelled', decided_at = ?, decision_by = ?
      WHERE conversation_id = ? AND bot_id = ? AND tool_call_id = ? AND status = 'pending'`,
    args: [new Date().toISOString(), `system:${reason}`, conversationId, botId, toolCallId],
  });
}

export async function failApprovalResume(
  conversationId: ConversationId,
  botId: string,
  toolCallId: string,
): Promise<void> {
  await (await db()).execute({
    sql: `UPDATE approval_requests
      SET status = 'failed', decided_at = ?, decision_by = 'system:resume-failed'
      WHERE conversation_id = ? AND bot_id = ? AND tool_call_id = ? AND status = 'approved'`,
    args: [new Date().toISOString(), conversationId, botId, toolCallId],
  });
}

export async function markApprovalOutcomeUnknown(
  conversationId: ConversationId,
  botId: string,
  toolCallId: string,
): Promise<void> {
  await (await db()).execute({
    sql: `UPDATE approval_requests
      SET status = 'outcome_unknown', decided_at = ?, decision_by = 'system:resume-outcome-unknown'
      WHERE conversation_id = ? AND bot_id = ? AND tool_call_id = ? AND status = 'approved'`,
    args: [new Date().toISOString(), conversationId, botId, toolCallId],
  });
}

export async function listApprovalRequests(limit = 100): Promise<ApprovalRequest[]> {
  const client = await db();
  const now = new Date().toISOString();
  await client.execute({
    sql: `UPDATE approval_requests
      SET status = 'expired', decided_at = ?, decision_by = 'system:expiration'
      WHERE status = 'pending' AND expires_at <= ?`,
    args: [now, now],
  });
  const rows = await client.execute({
    sql: `SELECT ${APPROVAL_COLUMNS} FROM approval_requests ORDER BY created_at DESC LIMIT ?`,
    args: [Math.max(1, Math.min(200, Math.floor(limit)))],
  });
  return rows.rows.map(decodeApprovalRequest);
}

/** Bumped by "Clear chat" so each bot starts a fresh model-side thread. */
export async function conversationGeneration(conversationId: ConversationId): Promise<number> {
  const rows = await (await db()).execute({
    sql: "SELECT generation FROM conversations WHERE id = ?",
    args: [conversationId],
  });
  return rows.rows[0] ? Number(rows.rows[0].generation) : 0;
}

export async function bumpGeneration(conversationId: ConversationId): Promise<number> {
  await (await db()).execute({
    sql: `INSERT INTO conversations (id, generation) VALUES (?, 1)
          ON CONFLICT(id) DO UPDATE SET generation = generation + 1`,
    args: [conversationId],
  });
  return conversationGeneration(conversationId);
}

// ── task executions ────────────────────────────────────────────────────

function executionHeader(execution: Execution): Omit<Execution, "tasks"> {
  const { tasks, ...header } = execution;
  void tasks;
  return header;
}

function decodeExecution(header: string, status: string, tasks: ExecutionTask[]): Execution {
  return { ...(JSON.parse(header) as Omit<Execution, "tasks">), status: status as Execution["status"], tasks };
}

export async function saveExecution(execution: Execution, collaborationMessages: CollaborationMessage[] = []): Promise<void> {
  const client = await db();
  const statements = [
    {
      sql: `INSERT INTO executions (id, status, created_at, updated_at, data, room_id, parent_execution_id, pattern_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data, room_id = excluded.room_id, parent_execution_id = excluded.parent_execution_id, pattern_key = excluded.pattern_key`,
      args: [
        execution.id,
        execution.status,
        execution.createdAt,
        new Date().toISOString(),
        JSON.stringify(executionHeader(execution)),
        execution.collaboration?.roomId ?? null,
        execution.collaboration?.parentExecutionId ?? null,
        execution.collaboration?.patternKey ?? null,
      ],
    },
    { sql: "DELETE FROM execution_tasks WHERE execution_id = ?", args: [execution.id] },
    ...execution.tasks.map((task) => ({
      sql: "INSERT INTO execution_tasks (id, execution_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
      args: [`${execution.id}:${task.id}`, execution.id, task.status, task.createdAt, JSON.stringify(task)],
    })),
    ...collaborationMessages.map((message) => ({
      sql: `INSERT INTO collaboration_messages (id, room_id, execution_id, type, response_to_id, created_at, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET type = excluded.type, response_to_id = excluded.response_to_id, data = excluded.data`,
      args: [
        message.id,
        message.roomId,
        message.executionId ?? null,
        message.type,
        message.responseToMessageId ?? null,
        message.createdAt,
        JSON.stringify(message),
      ],
    })),
  ];
  await client.batch(statements, "write");
}

export async function getExecution(id: string): Promise<Execution | null> {
  const client = await db();
  const rows = await client.execute({ sql: "SELECT status, data FROM executions WHERE id = ?", args: [id] });
  const row = rows.rows[0];
  if (!row) return null;
  const taskRows = await client.execute({
    sql: "SELECT data FROM execution_tasks WHERE execution_id = ? ORDER BY created_at, id",
    args: [id],
  });
  return decodeExecution(String(row.data), String(row.status), taskRows.rows.map((task) => JSON.parse(String(task.data)) as ExecutionTask));
}

export async function listExecutions(limit = 50): Promise<Execution[]> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT id, status, data FROM executions ORDER BY created_at DESC LIMIT ?",
    args: [Math.max(1, Math.min(100, Math.floor(limit)))],
  });
  return Promise.all(
    rows.rows.map(async (row) => {
      const taskRows = await client.execute({
        sql: "SELECT data FROM execution_tasks WHERE execution_id = ? ORDER BY created_at, id",
        args: [String(row.id)],
      });
      return decodeExecution(
        String(row.data),
        String(row.status),
        taskRows.rows.map((task) => JSON.parse(String(task.data)) as ExecutionTask),
      );
    }),
  );
}
export async function listRoomExecutions(roomId: string): Promise<Execution[]> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT id, status, data FROM executions WHERE room_id = ? ORDER BY created_at DESC LIMIT 50",
    args: [roomId],
  });
  return Promise.all(
    rows.rows.map(async (row) => {
      const taskRows = await client.execute({
        sql: "SELECT data FROM execution_tasks WHERE execution_id = ? ORDER BY created_at, id",
        args: [String(row.id)],
      });
      return decodeExecution(
        String(row.data),
        String(row.status),
        taskRows.rows.map((task) => JSON.parse(String(task.data)) as ExecutionTask),
      );
    }),
  );
}

export async function listChildExecutions(parentExecutionId: string): Promise<Execution[]> {
  const client = await db();
  const rows = await client.execute({
    sql: "SELECT id, status, data FROM executions WHERE parent_execution_id = ? ORDER BY created_at",
    args: [parentExecutionId],
  });
  return Promise.all(
    rows.rows.map(async (row) => {
      const taskRows = await client.execute({
        sql: "SELECT data FROM execution_tasks WHERE execution_id = ? ORDER BY created_at, id",
        args: [String(row.id)],
      });
      return decodeExecution(
        String(row.data),
        String(row.status),
        taskRows.rows.map((task) => JSON.parse(String(task.data)) as ExecutionTask),
      );
    }),
  );
}

export async function hasActiveRoomPattern(roomId: string, patternKey: string): Promise<boolean> {
  const rows = await (await db()).execute({
    sql: "SELECT 1 FROM executions WHERE room_id = ? AND pattern_key = ? AND status IN ('pending', 'running') LIMIT 1",
    args: [roomId, patternKey],
  });
  return rows.rows.length > 0;
}

export async function saveCollaborationMessage(message: CollaborationMessage): Promise<void> {
  await (await db()).execute({
    sql: `INSERT INTO collaboration_messages (id, room_id, execution_id, type, response_to_id, created_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET type = excluded.type, response_to_id = excluded.response_to_id, data = excluded.data`,
    args: [
      message.id,
      message.roomId,
      message.executionId ?? null,
      message.type,
      message.responseToMessageId ?? null,
      message.createdAt,
      JSON.stringify(message),
    ],
  });
}

export async function getCollaborationMessage(id: string): Promise<CollaborationMessage | null> {
  const rows = await (await db()).execute({
    sql: "SELECT data FROM collaboration_messages WHERE id = ?",
    args: [id],
  });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as CollaborationMessage) : null;
}

export async function hasCollaborationAnswer(questionId: string): Promise<boolean> {
  const rows = await (await db()).execute({
    sql: "SELECT 1 FROM collaboration_messages WHERE response_to_id = ? AND type = 'answer' LIMIT 1",
    args: [questionId],
  });
  return rows.rows.length > 0;
}

export async function listCollaborationMessages(roomId: string, limit = 100): Promise<CollaborationMessage[]> {
  const rows = await (await db()).execute({
    sql: `SELECT data FROM (
            SELECT data, created_at FROM collaboration_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
          ) ORDER BY created_at ASC`,
    args: [roomId, Math.max(1, Math.min(200, Math.floor(limit)))],
  });
  return rows.rows.map((row) => JSON.parse(String(row.data)) as CollaborationMessage);
}

export async function countRecentCollaborationMessages(roomId: string, since: string): Promise<number> {
  const result = await (await db()).execute({
    sql: "SELECT COUNT(*) AS count FROM collaboration_messages WHERE room_id = ? AND created_at >= ?",
    args: [roomId, since],
  });
  return Number(result.rows[0]?.count ?? 0);
}

export async function claimExecution(id: string): Promise<boolean> {
  const result = await (await db()).execute({
    sql: "UPDATE executions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
    args: [new Date().toISOString(), id],
  });
  return result.rowsAffected === 1;
}

export async function pendingExecutions(): Promise<Execution[]> {
  const client = await db();
  const rows = await client.execute("SELECT id FROM executions WHERE status = 'pending' ORDER BY created_at");
  return Promise.all(
    rows.rows.map(async (row) => {
      const execution = await getExecution(String(row.id));
      if (!execution) throw new Error("A pending execution disappeared while loading recovery state.");
      return execution;
    }),
  );
}

export async function recoverInterruptedExecutions(): Promise<void> {
  const client = await db();
  const rows = await client.execute("SELECT id FROM executions WHERE status = 'running'");
  for (const row of rows.rows) {
    const execution = await getExecution(String(row.id));
    if (!execution) continue;
    for (const task of execution.tasks) {
      if (task.status === "running" || task.status === "awaiting_approval" || task.status === "awaiting_input") {
        const sideEffectsPossible = task.sideEffectsPossible !== false;
        task.status = sideEffectsPossible ? "outcome_unknown" : "failed";
        task.error = sideEffectsPossible
          ? "Interrupted after tool activity; reconcile its outcome before retrying."
          : "Interrupted before an external action was confirmed.";
        task.completedAt = new Date().toISOString();
      } else if (task.status === "pending") {
        task.status = "cancelled";
        task.error = "Not started because the execution was interrupted.";
        task.completedAt = new Date().toISOString();
      }
    }

    execution.status = "failed";
    execution.error = execution.tasks.some((task) => task.status === "outcome_unknown")
      ? "Interrupted execution has task outcomes that require reconciliation."
      : "Interrupted by a server restart.";
    execution.completedAt = new Date().toISOString();
    await saveExecution(execution);
  }
}

// ── scheduled workflows ────────────────────────────────────────────────

    function decodeScheduledWorkflow(data: string, status: string, nextRunAt: unknown, updatedAt: string): ScheduledWorkflow {
      return {
        ...(JSON.parse(data) as ScheduledWorkflow),
        status: status as ScheduledWorkflow["status"],
        nextRunAt: nextRunAt === null ? null : String(nextRunAt),
        updatedAt,
      };
    }

    function decodeScheduledWorkflowRun(
      data: string,
      status: string,
      executionId: unknown,
      scheduledFor: string,
      startedAt: unknown,
      completedAt: unknown,
      error: unknown,
    ): ScheduledWorkflowRun {
      const run = JSON.parse(data) as ScheduledWorkflowRun;
      return {
        ...run,
        status: status as ScheduledWorkflowRun["status"],
        executionId: executionId === null ? undefined : String(executionId),
        scheduledFor,
        startedAt: startedAt === null ? undefined : String(startedAt),
        completedAt: completedAt === null ? undefined : String(completedAt),
        error: error === null ? undefined : String(error),
      };
    }

    export async function saveScheduledWorkflow(workflow: ScheduledWorkflow): Promise<void> {
      await (await db()).execute({
        sql: `INSERT INTO scheduled_workflows (id, status, next_run_at, updated_at, data)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status = excluded.status, next_run_at = excluded.next_run_at,
              updated_at = excluded.updated_at, data = excluded.data`,
        args: [workflow.id, workflow.status, workflow.nextRunAt, workflow.updatedAt, JSON.stringify(workflow)],
      });
    }

    export async function getScheduledWorkflow(id: string): Promise<ScheduledWorkflow | null> {
      const rows = await (await db()).execute({
        sql: "SELECT data, status, next_run_at, updated_at FROM scheduled_workflows WHERE id = ?",
        args: [id],
      });
      const row = rows.rows[0];
      return row ? decodeScheduledWorkflow(String(row.data), String(row.status), row.next_run_at, String(row.updated_at)) : null;
    }

    export async function listScheduledWorkflows(includeDeleted = false): Promise<ScheduledWorkflow[]> {
      const rows = await (await db()).execute({
        sql: `SELECT data, status, next_run_at, updated_at FROM scheduled_workflows
              ${includeDeleted ? "" : "WHERE status != 'deleted'"} ORDER BY COALESCE(next_run_at, updated_at), id`,
      });
      return rows.rows.map((row) =>
        decodeScheduledWorkflow(String(row.data), String(row.status), row.next_run_at, String(row.updated_at)),
      );
    }

    export async function claimScheduledWorkflowRun(
      run: ScheduledWorkflowRun,
    ): Promise<{ claimed: boolean; run: ScheduledWorkflowRun }> {
      const result = await (await db()).execute({
        sql: `INSERT OR IGNORE INTO scheduled_workflow_runs
              (id, workflow_id, occurrence_key, execution_id, status, scheduled_for, started_at, completed_at, error, created_at, data)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          run.id,
          run.workflowId,
          run.occurrenceKey,
          run.executionId ?? null,
          run.status,
          run.scheduledFor,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.error ?? null,
          run.createdAt,
          JSON.stringify(run),
        ],
      });
      if (result.rowsAffected === 1) return { claimed: true, run };

      const existing = await getScheduledWorkflowRunForOccurrence(run.workflowId, run.occurrenceKey);
      if (existing) return { claimed: false, run: existing };
      const active = await getActiveScheduledWorkflowRun(run.workflowId);
      if (active) return { claimed: false, run: active };
      throw new Error("Could not claim the scheduled workflow occurrence.");
    }

    export async function saveScheduledWorkflowRun(run: ScheduledWorkflowRun): Promise<void> {
      const result = await (await db()).execute({
        sql: `UPDATE scheduled_workflow_runs SET execution_id = ?, status = ?, scheduled_for = ?, started_at = ?,
              completed_at = ?, error = ?, data = ? WHERE id = ?`,
        args: [
          run.executionId ?? null,
          run.status,
          run.scheduledFor,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.error ?? null,
          JSON.stringify(run),
          run.id,
        ],
      });
      if (result.rowsAffected !== 1) throw new Error("The scheduled workflow run could not be updated.");
    }

    export async function getScheduledWorkflowRunForOccurrence(
      workflowId: string,
      occurrenceKey: string,
    ): Promise<ScheduledWorkflowRun | null> {
      const rows = await (await db()).execute({
        sql: `SELECT data, status, execution_id, scheduled_for, started_at, completed_at, error
              FROM scheduled_workflow_runs WHERE workflow_id = ? AND occurrence_key = ?`,
        args: [workflowId, occurrenceKey],
      });
      const row = rows.rows[0];
      return row
        ? decodeScheduledWorkflowRun(
            String(row.data),
            String(row.status),
            row.execution_id,
            String(row.scheduled_for),
            row.started_at,
            row.completed_at,
            row.error,
          )
        : null;
    }

    export async function getActiveScheduledWorkflowRun(workflowId: string): Promise<ScheduledWorkflowRun | null> {
      const rows = await (await db()).execute({
        sql: `SELECT data, status, execution_id, scheduled_for, started_at, completed_at, error
              FROM scheduled_workflow_runs WHERE workflow_id = ? AND status IN ('claimed', 'running')
              ORDER BY created_at LIMIT 1`,
        args: [workflowId],
      });
      const row = rows.rows[0];
      return row
        ? decodeScheduledWorkflowRun(
            String(row.data),
            String(row.status),
            row.execution_id,
            String(row.scheduled_for),
            row.started_at,
            row.completed_at,
            row.error,
          )
        : null;
    }

    export async function listScheduledWorkflowRuns(
      workflowId?: string,
      limit = 100,
      activeOnly = false,
      offset = 0,
    ): Promise<ScheduledWorkflowRun[]> {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (workflowId) {
        where.push("workflow_id = ?");
        args.push(workflowId);
      }
      if (activeOnly) where.push("status IN ('claimed', 'running')");
      args.push(Math.max(1, Math.min(500, Math.floor(limit))));
      args.push(Math.max(0, Math.floor(offset)));
      const rows = await (await db()).execute({
        sql: `SELECT data, status, execution_id, scheduled_for, started_at, completed_at, error
              FROM scheduled_workflow_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
              ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        args,
      });
      return rows.rows.map((row) =>
        decodeScheduledWorkflowRun(
          String(row.data),
          String(row.status),
          row.execution_id,
          String(row.scheduled_for),
          row.started_at,
          row.completed_at,
          row.error,
        ),
      );
    }
