// In-process scheduled workflow runner backed by SQLite persistence.
// Limitation: schedules & run history persist in SQLite across restarts, but
// automatic background ticking only runs while the Node server process is alive.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatMessage, ConversationId, ScheduleInput, ScheduleRecurrence, ScheduleRun, ScheduledWorkflow } from "@/lib/shared/types";
import { publish } from "./bus";
import * as store from "./db";
import { InputError } from "./errors";
import { roomConversationId, runRoom } from "./rooms";
import { runTurn } from "./runtime";

const TICK_MS = 5_000;
const RETRY_BASE_MS = 10_000;

const ScheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dm"), botId: z.string().trim().min(1) }),
  z.object({ kind: z.literal("room"), roomId: z.string().trim().min(1) }),
]);

export const ScheduleInputSchema = z.object({
  name: z.string().trim().min(1, "Give the scheduled workflow a name.").max(80),
  target: ScheduleTargetSchema,
  prompt: z.string().trim().min(1, "Provide instructions or a prompt to run.").max(4000),
  recurrence: z.enum(["once", "interval", "daily", "weekly"]),
  intervalMinutes: z.number().int().min(1).max(10_080).optional(),
  nextRunAt: z.string().trim().min(1),
  enabled: z.boolean().optional().default(true),
  maxRetries: z.number().int().min(0).max(5).optional().default(2),
});

interface SchedulerGlobals {
  __opencrewbotScheduler?: {
    timer?: ReturnType<typeof setInterval>;
    inFlight: Set<string>;
    ticking: boolean;
  };
}

const g = globalThis as unknown as SchedulerGlobals;
const state = (g.__opencrewbotScheduler ??= { inFlight: new Set(), ticking: false });

function parseIso(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new InputError("Invalid nextRunAt date/time.");
  return d.toISOString();
}

export function computeNextRunAt(fromIso: string, recurrence: ScheduleRecurrence, intervalMinutes = 60): string {
  const base = Math.max(Date.now(), new Date(fromIso).getTime());
  const d = new Date(base);
  switch (recurrence) {
    case "once":
      return d.toISOString();
    case "interval":
      return new Date(base + Math.max(1, intervalMinutes) * 60_000).toISOString();
    case "daily":
      return new Date(base + 24 * 60 * 60_000).toISOString();
    case "weekly":
      return new Date(base + 7 * 24 * 60 * 60_000).toISOString();
  }
}

function conversationFor(schedule: ScheduledWorkflow): ConversationId {
  return schedule.target.kind === "dm" ? `dm:${schedule.target.botId}` : roomConversationId(schedule.target.roomId);
}

export async function listAllSchedules(): Promise<ScheduledWorkflow[]> {
  return store.listSchedules();
}

export async function listRuns(limit = 50, scheduleId?: string): Promise<ScheduleRun[]> {
  return store.listScheduleRuns(limit, scheduleId);
}

export async function createSchedule(raw: ScheduleInput): Promise<ScheduledWorkflow> {
  const parsed = ScheduleInputSchema.safeParse(raw);
  if (!parsed.success) throw new InputError(parsed.error.issues[0]?.message || "Invalid schedule.");
  const data = parsed.data;
  if (data.target.kind === "dm") {
    const bot = await store.getBot(data.target.botId);
    if (!bot) throw new InputError("Target bot does not exist.");
  } else {
    const room = await store.getRoom(data.target.roomId);
    if (!room) throw new InputError("Target room does not exist.");
    if (room.memberIds.length === 0) throw new InputError("Target room has no members.");
  }

  const schedule: ScheduledWorkflow = {
    id: randomUUID().slice(0, 8),
    name: data.name,
    target: data.target,
    prompt: data.prompt,
    recurrence: data.recurrence,
    intervalMinutes: data.recurrence === "interval" ? (data.intervalMinutes ?? 60) : undefined,
    nextRunAt: parseIso(data.nextRunAt),
    enabled: data.enabled,
    maxRetries: data.maxRetries,
    retryCount: 0,
    createdAt: new Date().toISOString(),
  };
  await store.saveSchedule(schedule);
  publish({ type: "schedules-changed" });
  return schedule;
}

export async function updateSchedule(
  id: string,
  patch: Partial<Pick<ScheduledWorkflow, "name" | "prompt" | "recurrence" | "intervalMinutes" | "nextRunAt" | "enabled" | "maxRetries">>,
): Promise<ScheduledWorkflow> {
  const existing = await store.getSchedule(id);
  if (!existing) throw new InputError("Scheduled workflow does not exist.");
  const next: ScheduledWorkflow = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
    ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
    ...(patch.intervalMinutes !== undefined ? { intervalMinutes: patch.intervalMinutes } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: parseIso(patch.nextRunAt) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.maxRetries !== undefined ? { maxRetries: Math.min(5, Math.max(0, patch.maxRetries)) } : {}),
  };
  if (!next.name) throw new InputError("Give the scheduled workflow a name.");
  if (!next.prompt) throw new InputError("Provide instructions or a prompt to run.");
  await store.saveSchedule(next);
  publish({ type: "schedules-changed" });
  return next;
}

export async function deleteSchedule(id: string): Promise<void> {
  await store.deleteScheduleRow(id);
  publish({ type: "schedules-changed" });
}

export async function executeSchedule(id: string): Promise<ScheduleRun> {
  const schedule = await store.getSchedule(id);
  if (!schedule) throw new InputError("Scheduled workflow does not exist.");
  if (state.inFlight.has(id)) throw new InputError(`Schedule "${schedule.name}" is already running.`);

  state.inFlight.add(id);
  const startedAt = new Date().toISOString();
  const attempt = schedule.retryCount + 1;
  const conversationId = conversationFor(schedule);
  const run: ScheduleRun = {
    id: randomUUID(),
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    conversationId,
    startedAt,
    status: "running",
    attempt,
    willRetry: false,
  };

  schedule.lastStatus = "running";
  schedule.lastRunAt = startedAt;
  await store.saveSchedule(schedule);
  await store.saveScheduleRun(run);
  publish({ type: "schedules-changed" });

  try {
    const triggerText = `[Scheduled workflow: ${schedule.name}] ${schedule.prompt}`;
    const userMessage: ChatMessage = {
      id: randomUUID(),
      conversationId,
      role: "user",
      createdAt: new Date().toISOString(),
      status: "done",
      parts: [{ kind: "text", text: triggerText }],
    };

    if (schedule.target.kind === "dm") {
      const bot = await store.getBot(schedule.target.botId);
      if (!bot) throw new Error(`Target bot "${schedule.target.botId}" no longer exists.`);
      await store.saveMessage(userMessage);
      await store.markRead(conversationId);
      publish({ type: "message", message: userMessage });

      const reply = await runTurn({ bot, conversationId, content: triggerText });
      if (!reply) throw new Error("Scheduled run was stopped before starting.");
      run.messageIds = [reply.id];
      run.simulated = reply.model === "mock";
      if (reply.status === "error") throw new Error(reply.error || "Bot turn ended in error.");
    } else {
      const room = await store.getRoom(schedule.target.roomId);
      if (!room) throw new Error(`Target room "${schedule.target.roomId}" no longer exists.`);
      if (room.memberIds.length === 0) throw new Error(`Target room "${room.name}" has no members.`);
      await store.saveMessage(userMessage);
      await store.markRead(conversationId);
      publish({ type: "message", message: userMessage });

      const beforeIds = new Set((await store.listMessages(conversationId, 60)).map((m) => m.id));
      await runRoom(room, userMessage);
      const after = await store.listMessages(conversationId, 60);
      const created = after.filter((m) => !beforeIds.has(m.id) && m.role === "bot");
      run.messageIds = created.map((m) => m.id);
      run.simulated = created.some((m) => m.model === "mock");
      const failedReply = created.find((m) => m.status === "error");
      if (failedReply) throw new Error(failedReply.error || "A room worker ended in error.");
      if (created.length === 0) throw new Error("No bot replies were produced for this scheduled room run.");
    }

    run.status = "success";
    run.finishedAt = new Date().toISOString();
    schedule.retryCount = 0;
    schedule.lastStatus = "success";
    schedule.lastError = undefined;
    if (schedule.recurrence === "once") {
      schedule.enabled = false;
    } else {
      schedule.nextRunAt = computeNextRunAt(schedule.nextRunAt, schedule.recurrence, schedule.intervalMinutes);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    run.error = errMsg;
    run.finishedAt = new Date().toISOString();
    schedule.lastStatus = "failed";
    schedule.lastError = errMsg;
    schedule.retryCount += 1;

    if (schedule.retryCount <= schedule.maxRetries) {
      run.willRetry = true;
      schedule.nextRunAt = new Date(Date.now() + RETRY_BASE_MS * schedule.retryCount).toISOString();
      schedule.enabled = true;
    } else {
      run.willRetry = false;
      schedule.retryCount = 0;
      if (schedule.recurrence === "once") {
        schedule.enabled = false;
      } else {
        schedule.nextRunAt = computeNextRunAt(schedule.nextRunAt, schedule.recurrence, schedule.intervalMinutes);
      }
    }
  } finally {
    state.inFlight.delete(id);
    await store.saveSchedule(schedule);
    await store.saveScheduleRun(run);
    publish({ type: "schedules-changed" });
  }
  return run;
}

export async function tickDueSchedules(): Promise<ScheduleRun[]> {
  if (state.ticking) return [];
  state.ticking = true;
  const runs: ScheduleRun[] = [];
  try {
    const now = Date.now();
    const all = await store.listSchedules();
    for (const s of all) {
      if (!s.enabled || state.inFlight.has(s.id)) continue;
      if (new Date(s.nextRunAt).getTime() <= now) {
        const run = await executeSchedule(s.id).catch(() => null);
        if (run) runs.push(run);
      }
    }
  } finally {
    state.ticking = false;
  }
  return runs;
}

export function ensureSchedulerStarted(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void tickDueSchedules().catch(() => {});
  }, TICK_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}
