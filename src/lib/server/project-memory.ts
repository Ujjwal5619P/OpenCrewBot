import { InputError } from "./errors";
import { db, getBot, listBots } from "./db";

const ACCESS_SETTING = "project_memory_authorized_bot_ids";

interface ProjectMemoryAccessState {
  authorizedBotIds: string[];
  accessGenerations: Record<string, number>;
}

async function readAccessState(): Promise<{ state: ProjectMemoryAccessState; raw: string | null }> {
  const rows = await (await db()).execute({
    sql: "SELECT data FROM settings WHERE key = ?",
    args: [ACCESS_SETTING],
  });
  const raw = rows.rows[0] ? String(rows.rows[0].data) : null;
  if (raw === null) return { state: { authorizedBotIds: [], accessGenerations: {} }, raw };

  const value: unknown = JSON.parse(raw);
  if (Array.isArray(value)) {
    return {
      state: {
        authorizedBotIds: value.filter((id): id is string => typeof id === "string"),
        accessGenerations: {},
      },
      raw,
    };
  }
  if (typeof value !== "object" || value === null) {
    return { state: { authorizedBotIds: [], accessGenerations: {} }, raw };
  }

  const record = value as Record<string, unknown>;
  const generations =
    typeof record.accessGenerations === "object" && record.accessGenerations !== null
      ? Object.fromEntries(
          Object.entries(record.accessGenerations).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
          ),
        )
      : {};
  return {
    state: {
      authorizedBotIds: Array.isArray(record.authorizedBotIds)
        ? record.authorizedBotIds.filter((id): id is string => typeof id === "string")
        : [],
      accessGenerations: generations,
    },
    raw,
  };
}

async function existingBotIds(ids: string[]): Promise<string[]> {
  const existing = new Set((await listBots()).map((bot) => bot.id));
  return [...new Set(ids.filter((id) => existing.has(id)))];
}

function parseBotIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new InputError("Authorized bot IDs must be a list of existing bot IDs.");
  }
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !id.trim()) {
      throw new InputError("Authorized bot IDs must be a list of existing bot IDs.");
    }
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) throw new InputError("Authorized bot IDs must not contain duplicates.");
  return ids;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export async function authorizedProjectMemoryBots(): Promise<string[]> {
  const { state } = await readAccessState();
  return existingBotIds(state.authorizedBotIds);
}

export async function canAccessProjectMemory(botId: string): Promise<boolean> {
  if (!(await getBot(botId))) return false;
  return (await authorizedProjectMemoryBots()).includes(botId);
}

export async function setAuthorizedProjectMemoryBots(value: unknown, expectedValue: unknown): Promise<string[] | null> {
  const ids = parseBotIds(value);
  const expectedIds = parseBotIds(expectedValue);
  const existing = new Set((await listBots()).map((bot) => bot.id));
  if (ids.some((id) => !existing.has(id))) throw new InputError("Every authorized bot must exist.");

  const { state, raw } = await readAccessState();
  const currentIds = await existingBotIds(state.authorizedBotIds);
  if (!sameIds(currentIds, expectedIds)) return null;

  const revokedIds = currentIds.filter((id) => !ids.includes(id));
  const accessGenerations = { ...state.accessGenerations };
  for (const id of revokedIds) accessGenerations[id] = (accessGenerations[id] ?? 0) + 1;
  const next = JSON.stringify({ authorizedBotIds: ids, accessGenerations });
  const client = await db();
  const result = raw === null
    ? await client.execute({
        sql: "INSERT OR IGNORE INTO settings (key, data) VALUES (?, ?)",
        args: [ACCESS_SETTING, next],
      })
    : await client.execute({
        sql: "UPDATE settings SET data = ? WHERE key = ? AND data = ?",
        args: [next, ACCESS_SETTING, raw],
      });
  if (result.rowsAffected === 0) return null;
  return ids;
}

export async function projectMemoryThreadId(baseThreadId: string, botId: string): Promise<string> {
  const { state } = await readAccessState();
  const generation = state.accessGenerations[botId] ?? 0;
  return generation === 0 ? baseThreadId : `${baseThreadId}:project-memory-${generation}`;
}
