// What the API routes call. Keeps validation and side effects in one place.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot, BotInput, ChatMessage, ConversationId, ConversationSummary, Room, RoomInput } from "@/lib/shared/types";
import { DATA_DIR, keys } from "./config";
import { InputError } from "./errors";
import * as store from "./db";
import { publish } from "./bus";
import { DEFAULT_MODEL } from "./models";
import { deleteRoomWorkspace, deleteWorkspace, writeMemory, writeRoomMemory } from "./memory-files";
import { forgetConversation, resetBot, runTurn, runningBots, stopConversation } from "./runtime";
import { messagePreview } from "@/lib/shared/preview";
import { roomConversationId, runRoom } from "./rooms";

import { ensureSchedulerStarted } from "./scheduler";

export { InputError };

// ── seeding and restart cleanup (once per process) ──────────────────────

const g = globalThis as unknown as { __opencrewbotBoot?: Promise<void> };

export function boot(): Promise<void> {
  g.__opencrewbotBoot ??= (async () => {
    await sweepInterrupted();
    await seed();
    ensureSchedulerStarted();
  })();
  return g.__opencrewbotBoot;
}

/** A turn that was streaming when the server stopped can't resume. Say so. */
async function sweepInterrupted() {
  const client = await store.db();
  const rows = await client.execute(`SELECT data FROM messages WHERE data LIKE '%"status":"streaming"%'`);
  for (const r of rows.rows) {
    const m = JSON.parse(String(r.data)) as ChatMessage;
    if (m.status !== "streaming") continue;
    m.status = "stopped";
    m.error = "Interrupted by a server restart.";
    for (const p of m.parts) if (p.kind === "tool" && (p.status === "running" || p.status === "awaiting-approval")) p.status = "denied";
    await store.saveMessage(m);
  }
}

const SEED_MARKER = join(DATA_DIR, ".seeded");
const WORKFORCE_VERSION = 3;

async function seed() {
  const version = (await store.getSetting<number>("workforce.version")) ?? 0;
  if (version >= WORKFORCE_VERSION && existsSync(SEED_MARKER)) return;

  const tools = { webSearch: true, memory: true, codeMode: false, browser: false, askUser: true };

  const botDefs: BotInput[] = [
    {
      name: "Scout",
      handle: "scout",
      title: "Research",
      description: "Finds things out on the web and comes back with sourced answers.",
      instructions:
        "Research before answering anything time-sensitive. Search, read the best two or three sources, then answer with the URLs you used. Say plainly when sources disagree or you couldn't verify something.",
      emoji: "🔭",
      color: "#2f7df6",
      model: DEFAULT_MODEL,
      tools: { ...tools, codeMode: true },
      approval: "ask",
      pinned: true,
    },
    {
      name: "Quill",
      handle: "quill",
      title: "Writing",
      description: "Turns notes and research into clear posts, docs and emails.",
      instructions:
        "Write in plain, specific language. Match the person's voice once you know it, and keep their style preferences in memory. Offer one tight draft, not three options.",
      emoji: "✒️",
      color: "#e0663d",
      model: DEFAULT_MODEL,
      tools: { ...tools, webSearch: false },
      approval: "ask",
      pinned: false,
    },
    {
      name: "Atlas",
      handle: "atlas",
      title: "Planning",
      description: "Breaks goals into steps, keeps track of decisions, and pulls in teammates.",
      instructions:
        "Turn vague goals into a short, ordered plan with owners. Keep decisions and open questions in memory. In rooms, delegate structured tasks using actual room member IDs or @handles.",
      emoji: "🧭",
      color: "#1f9d6b",
      model: DEFAULT_MODEL,
      tools,
      approval: "ask",
      pinned: false,
    },
    {
      name: "Analyst",
      handle: "analyst",
      title: "Data & Spreadsheets",
      description: "Analyzes spreadsheets, CSVs, cohorts, and business metrics with exact calculations.",
      instructions:
        "Use execute_typescript for exact arithmetic, cohort aggregations, margins, and spreadsheet transforms. Show tables clearly and call out data assumptions or anomalies.",
      emoji: "📊",
      color: "#8b5cf6",
      model: DEFAULT_MODEL,
      tools: { ...tools, webSearch: false, codeMode: true },
      approval: "ask",
      pinned: false,
    },
    {
      name: "Growth",
      handle: "growth",
      title: "Marketing & Campaigns",
      description: "Designs acquisition campaigns, messaging angles, funnels, and launch assets.",
      instructions:
        "Build focused campaign plans with target audience, positioning, channels, messaging hooks, and measurable KPIs. Coordinate with @scout for research, @quill for copy, and @finance for budget.",
      emoji: "📣",
      color: "#ec4899",
      model: DEFAULT_MODEL,
      tools,
      approval: "ask",
      pinned: false,
    },
    {
      name: "Engineer",
      handle: "engineer",
      title: "Software Engineering",
      description: "Writes, reviews, and ships technical specs, code, and GitHub workflows.",
      instructions:
        "Give concrete, production-ready technical solutions, PR reviews, and implementation plans. Use execute_typescript when verifying algorithms or data transforms.",
      emoji: "🛠️",
      color: "#14b8a6",
      model: DEFAULT_MODEL,
      tools: { ...tools, codeMode: true },
      connections: keys.github() ? ["github:env"] : [],
      approval: "ask",
      pinned: false,
    },
    {
      name: "Finance",
      handle: "finance",
      title: "Finance & Modeling",
      description: "Builds budgets, unit economics, burn/runway models, and pricing analyses.",
      instructions:
        "Verify every financial calculation with execute_typescript. Break down CAC, LTV, burn, payback, and budget line items clearly with sensitivity ranges.",
      emoji: "💼",
      color: "#f59e0b",
      model: DEFAULT_MODEL,
      tools: { ...tools, webSearch: false, codeMode: true },
      approval: "ask",
      pinned: false,
    },
    {
      name: "Ops",
      handle: "ops",
      title: "Operations & Scheduling",
      description: "Runs checklists, recurring monitoring, SLAs, approvals, and execution workflows.",
      instructions:
        "Track recurring schedules, competitor monitoring cadences, operational checklists, and approval gates. Keep status reports concise and action-oriented.",
      emoji: "⚙️",
      color: "#eab308",
      model: DEFAULT_MODEL,
      tools: { ...tools, codeMode: true, browser: true },
      approval: "ask",
      pinned: false,
    },
  ];

  const existingBots = await store.listBots();
  const botsByKey = new Map<string, Bot>();
  for (const b of existingBots) {
    botsByKey.set(b.name.toLowerCase(), b);
    botsByKey.set(b.handle.toLowerCase(), b);
  }

  for (const def of botDefs) {
    const existing = botsByKey.get(def.name.toLowerCase()) ?? botsByKey.get((def.handle ?? "").toLowerCase());
    if (existing) {
      let changed = false;
      const repaired = { ...existing };
      // Safely migrate legacy pre-Ollama seeded Nebius default when NEBIUS_API_KEY is not configured.
      if (!keys.nebius() && (!repaired.model || repaired.model === "MiniMaxAI/MiniMax-M3")) {
        repaired.model = DEFAULT_MODEL;
        changed = true;
      }
      if (!repaired.handle) {
        repaired.handle = await uniqueHandle(def.handle || repaired.name, repaired.id);
        changed = true;
      }
      if (changed) {
        await store.saveBot(repaired);
      }
      botsByKey.set(def.name.toLowerCase(), repaired);
      botsByKey.set(repaired.handle.toLowerCase(), repaired);
      continue;
    }
    const created = await createBot(def);
    botsByKey.set(def.name.toLowerCase(), created);
    botsByKey.set(created.handle.toLowerCase(), created);
  }

  const botId = (name: string) => botsByKey.get(name.toLowerCase())!.id;

  const roomDefs: Array<{ name: string; topic: string; emoji: string; members: string[]; lead: string; responder: RoomInput["responder"]; pinned: boolean }> = [
    {
      name: "Studio",
      topic: "Content and launches",
      emoji: "🎬",
      members: ["Atlas", "Scout", "Quill", "Growth"],
      lead: "Atlas",
      responder: "auto",
      pinned: true,
    },
    {
      name: "Market Intelligence",
      topic: "Competitor tracking, market signals, and research synthesis",
      emoji: "🛰️",
      members: ["Scout", "Analyst", "Atlas", "Ops"],
      lead: "Scout",
      responder: "auto",
      pinned: true,
    },
    {
      name: "Product & Engineering",
      topic: "Architecture, GitHub development, and technical delivery",
      emoji: "🧩",
      members: ["Engineer", "Atlas", "Ops", "Scout"],
      lead: "Engineer",
      responder: "auto",
      pinned: false,
    },
    {
      name: "MeetUniversity Campaign",
      topic: "Class 11 Aspirations marketing campaign, content, and budget",
      emoji: "🎓",
      members: ["Growth", "Quill", "Scout", "Finance", "Atlas"],
      lead: "Growth",
      responder: "auto",
      pinned: false,
    },
  ];

  const existingRooms = await store.listRooms();
  const roomsByName = new Map(existingRooms.map((r) => [r.name.toLowerCase(), r]));
  const knownBotIds = new Set((await store.listBots()).map((b) => b.id));

  for (const def of roomDefs) {
    const existing = roomsByName.get(def.name.toLowerCase());
    if (!existing) {
      await createRoom({
        name: def.name,
        topic: def.topic,
        emoji: def.emoji,
        memberIds: def.members.map(botId),
        leadId: botId(def.lead),
        responder: def.responder,
        pinned: def.pinned,
      });
      continue;
    }
    // Non-destructive repair: ensure required members/lead are valid without removing user-added members.
    const requiredIds = def.members.map(botId);
    const mergedMembers = [...new Set([...existing.memberIds.filter((id) => knownBotIds.has(id)), ...requiredIds])];
    const validLead = existing.leadId && mergedMembers.includes(existing.leadId) ? existing.leadId : botId(def.lead);
    if (
      mergedMembers.length !== existing.memberIds.length ||
      mergedMembers.some((id, idx) => existing.memberIds[idx] !== id) ||
      validLead !== existing.leadId
    ) {
      await store.saveRoom({ ...existing, memberIds: mergedMembers, leadId: validLead });
    }
  }

  // Sanitize any user-created rooms as well (deduplicate memberIds and ensure leadId is in memberIds).
  for (const room of await store.listRooms()) {
    const cleanMembers = [...new Set(room.memberIds)].filter((id) => knownBotIds.has(id));
    const cleanLead = room.leadId && cleanMembers.includes(room.leadId) ? room.leadId : (cleanMembers[0] ?? null);
    if (cleanMembers.length !== room.memberIds.length || cleanLead !== room.leadId) {
      await store.saveRoom({ ...room, memberIds: cleanMembers, leadId: cleanLead });
    }
  }

  await store.setSetting("workforce.version", WORKFORCE_VERSION);
  writeFileSync(SEED_MARKER, new Date().toISOString());
}

// ── bots ────────────────────────────────────────────────────────────────

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "bot";
}

async function uniqueHandle(wanted: string, exceptId?: string): Promise<string> {
  const taken = new Set((await store.listBots()).filter((b) => b.id !== exceptId).map((b) => b.handle));
  const base = slug(wanted);
  let handle = base;
  for (let n = 2; taken.has(handle) || ["everyone", "all"].includes(handle); n++) handle = `${base}${n}`;
  return handle;
}

function validateBot(input: Partial<BotInput>) {
  if (input.name !== undefined && !input.name.trim()) throw new InputError("A bot needs a name.");
  if (input.name && input.name.length > 40) throw new InputError("Keep the name under 40 characters.");
  if (input.instructions && input.instructions.length > 8000) throw new InputError("Instructions are limited to 8,000 characters.");
}

export async function createBot(input: BotInput): Promise<Bot> {
  validateBot(input);
  const bot: Bot = {
    ...input,
    id: randomUUID().slice(0, 8),
    name: input.name.trim(),
    connections: input.connections ?? [],
    handle: await uniqueHandle(input.handle || input.name),
    createdAt: new Date().toISOString(),
  };
  await store.saveBot(bot);
  writeMemory(bot.id, `# ${bot.name}'s memory\n\n`);
  publish({ type: "bots-changed" });
  return bot;
}

export async function updateBot(id: string, patch: Partial<BotInput>): Promise<Bot> {
  const bot = await store.getBot(id);
  if (!bot) throw new InputError("That bot doesn't exist.");
  validateBot(patch);
  const next: Bot = {
    ...bot,
    ...patch,
    id: bot.id,
    createdAt: bot.createdAt,
    tools: { ...bot.tools, ...(patch.tools ?? {}) },
    handle: patch.handle !== undefined || patch.name !== undefined ? await uniqueHandle(patch.handle || patch.name || bot.handle, id) : bot.handle,
  };
  await store.saveBot(next);
  await resetBot(id);
  publish({ type: "bots-changed" });
  return next;
}

export async function deleteBot(id: string): Promise<void> {
  await stopConversation(`dm:${id}`);
  await resetBot(id);
  await store.deleteBotRow(id);
  await store.clearMessages(`dm:${id}`);
  for (const room of await store.listRooms()) {
    if (!room.memberIds.includes(id)) continue;
    const memberIds = room.memberIds.filter((m) => m !== id);
    await store.saveRoom({ ...room, memberIds, leadId: room.leadId === id ? (memberIds[0] ?? null) : room.leadId });
  }
  deleteWorkspace(id);
  publish({ type: "bots-changed" });
  publish({ type: "rooms-changed" });
}

// ── rooms ───────────────────────────────────────────────────────────────

async function cleanRoomInput<T extends Partial<RoomInput>>(input: T): Promise<T> {
  if (input.name !== undefined && !input.name.trim()) throw new InputError("A room needs a name.");
  if (input.memberIds) {
    const known = new Set((await store.listBots()).map((b) => b.id));
    input.memberIds = [...new Set(input.memberIds)].filter((id) => known.has(id));
  }
  return input;
}

export async function createRoom(input: RoomInput): Promise<Room> {
  const clean = await cleanRoomInput(input);
  const room: Room = {
    ...clean,
    id: randomUUID().slice(0, 8),
    name: clean.name.trim(),
    leadId: clean.leadId && clean.memberIds.includes(clean.leadId) ? clean.leadId : (clean.memberIds[0] ?? null),
    createdAt: new Date().toISOString(),
  };
  await store.saveRoom(room);
  writeRoomMemory(room.id, `# ${room.name} shared memory\n\n`);
  publish({ type: "rooms-changed" });
  return room;
}

export async function updateRoom(id: string, patch: Partial<RoomInput>): Promise<Room> {
  const room = await store.getRoom(id);
  if (!room) throw new InputError("That room doesn't exist.");
  const clean = await cleanRoomInput(patch);
  const next: Room = { ...room, ...clean, id: room.id, createdAt: room.createdAt };
  if (!next.leadId || !next.memberIds.includes(next.leadId)) next.leadId = next.memberIds[0] ?? null;
  await store.saveRoom(next);
  publish({ type: "rooms-changed" });
  return next;
}

export async function deleteRoom(id: string): Promise<void> {
  const conversationId = roomConversationId(id);
  await stopConversation(conversationId);
  await store.deleteRoomRow(id);
  await store.clearMessages(conversationId);
  deleteRoomWorkspace(id);
  publish({ type: "rooms-changed" });
}

// ── conversations ───────────────────────────────────────────────────────

function parseConversation(conversationId: ConversationId): { kind: "dm" | "room"; id: string } {
  const [kind, id] = conversationId.split(":");
  if ((kind !== "dm" && kind !== "room") || !id) throw new InputError("Unknown conversation.");
  return { kind, id };
}

export async function sendMessage(conversationId: ConversationId, text: string): Promise<ChatMessage> {
  const content = text.trim();
  if (!content) throw new InputError("Type a message first.");
  if (content.length > 20000) throw new InputError("Messages are limited to 20,000 characters.");
  const { kind, id } = parseConversation(conversationId);

  const bot = kind === "dm" ? await store.getBot(id) : null;
  const room = kind === "room" ? await store.getRoom(id) : null;
  if (kind === "dm" && !bot) throw new InputError("That bot doesn't exist.");
  if (kind === "room" && !room) throw new InputError("That room doesn't exist.");
  if (room && room.memberIds.length === 0) throw new InputError("Add at least one bot to this room first.");

  const message: ChatMessage = {
    id: randomUUID(),
    conversationId,
    role: "user",
    createdAt: new Date().toISOString(),
    status: "done",
    parts: [{ kind: "text", text: content }],
  };
  await store.saveMessage(message);
  await store.markRead(conversationId);
  publish({ type: "message", message });

  // The reply streams over SSE; the request returns as soon as it's queued.
  if (bot) void runTurn({ bot, conversationId, content }).catch(() => {});
  if (room) void runRoom(room, message).catch(() => {});
  return message;
}

export async function clearConversation(conversationId: ConversationId): Promise<void> {
  parseConversation(conversationId);
  await stopConversation(conversationId);
  await store.clearMessages(conversationId);
  await store.bumpGeneration(conversationId);
  forgetConversation(conversationId);
}

export async function summaries(): Promise<ConversationSummary[]> {
  const [bots, rooms, last, unread] = await Promise.all([store.listBots(), store.listRooms(), store.lastMessages(), store.unreadCounts()]);
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const ids = [...bots.map((b) => `dm:${b.id}`), ...rooms.map((r) => roomConversationId(r.id))];
  return ids.map((id) => {
    const m = last.get(id);
    return {
      id,
      running: runningBots(id),
      unread: unread.get(id) ?? 0,
      lastMessage: m
        ? {
            text: messagePreview(m),
            createdAt: m.createdAt,
            author: m.role === "user" ? "You" : (names.get(m.botId ?? "") ?? "Bot"),
          }
        : undefined,
    };
  });
}
