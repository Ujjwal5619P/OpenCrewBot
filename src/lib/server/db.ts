// App storage: bots, rooms, and the chat transcript the UI shows. Mastra keeps
// its own store (mastra.db) for each bot's model-facing thread history.
import { createClient, type Client } from "@libsql/client";
import { APP_DB_URL } from "./config";
import type { Bot, ChatMessage, ConversationId, Execution, ExecutionTask, Room } from "@/lib/shared/types";

// Cached across hot reloads, together with the file it points at, so a
// changed database path opens a fresh connection instead of reusing one
// bound to a file that has moved.
const g = globalThis as unknown as { __opencrewbotDb?: { url: string; schema?: number; client: Promise<Client> } };

/** Bump when a table is added, so a hot-reloaded server re-runs the CREATE statements. */
const SCHEMA_VERSION = 3;

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

export async function saveExecution(execution: Execution): Promise<void> {
  const client = await db();
  const statements = [
    {
      sql: `INSERT INTO executions (id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      args: [execution.id, execution.status, execution.createdAt, new Date().toISOString(), JSON.stringify(executionHeader(execution))],
    },
    { sql: "DELETE FROM execution_tasks WHERE execution_id = ?", args: [execution.id] },
    ...execution.tasks.map((task) => ({
      sql: "INSERT INTO execution_tasks (id, execution_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
      args: [`${execution.id}:${task.id}`, execution.id, task.status, task.createdAt, JSON.stringify(task)],
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
