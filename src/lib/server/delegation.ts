// Structured room task delegation: normalization, unique task ID generation,
// strict room member resolution, cycle & dependency validation, parallel DAG
// execution, failure/recovery handling, and SQLite status persistence.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Bot,
  ChatMessage,
  ConversationId,
  DelegationRunRecord,
  DelegationTaskRecord,
  Room,
  RouteNote,
} from "@/lib/shared/types";
import { InputError } from "./errors";

export const DelegationTaskInputSchema = z.object({
  id: z.string().trim().min(1, "Each task needs a valid string id.").max(64),
  title: z.string().trim().min(1, "Each task needs a title.").max(160),
  instructions: z.string().trim().min(1, "Each task needs instructions.").max(4000),
  assignee: z.string().trim().min(1, "Each task needs an assignee (bot id, @handle, or name from this room).").max(80),
  fallbackAssignee: z.string().trim().min(1).max(80).optional(),
  dependsOn: z.array(z.string().trim().min(1)).max(20).optional().default([]),
});

export const DelegationPlanInputSchema = z.object({
  tasks: z
    .array(DelegationTaskInputSchema)
    .min(1, "Delegation must include 1-20 valid structured tasks.")
    .max(20, "Delegation must include 1-20 valid structured tasks."),
});

/**
 * JSON-Schema-friendly tool input schema for LLM tool calling (allows missing
 * task IDs so normalizeDelegationInput can auto-generate deterministic unique
 * IDs before strict validation).
 */
export const DelegationToolInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().optional().describe("Unique task ID (auto-generated if omitted)."),
        title: z.string().min(1).describe("Short task title."),
        instructions: z.string().min(1).describe("Clear instructions for the assigned room member."),
        assignee: z.string().min(1).describe("Exact @handle, id, or name of a member in THIS room."),
        fallbackAssignee: z.string().optional().describe("Optional backup member in THIS room if the primary fails."),
        dependsOn: z.array(z.string()).optional().describe("Optional list of upstream task IDs that must complete first."),
      }),
    )
    .min(1, "Delegation requires a non-empty tasks array.")
    .max(20)
    .describe("1-20 tasks assigned strictly to current room members."),
});

export type DelegationTaskInput = z.infer<typeof DelegationTaskInputSchema>;
export type DelegationPlanInput = z.infer<typeof DelegationPlanInputSchema>;

export type DelegationTaskStatus = "pending" | "running" | "done" | "error" | "blocked" | "stopped";
export type DelegationOutcome = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";

export interface ResolvedDelegationTask {
  id: string;
  title: string;
  instructions: string;
  assigneeBot: Bot;
  fallbackAssigneeBot?: Bot;
  dependsOn: string[];
}

export interface DelegationTaskReport {
  id: string;
  title: string;
  botId: string;
  botName: string;
  botHandle: string;
  model?: string;
  dependsOn: string[];
  status: DelegationTaskStatus;
  outcome: DelegationOutcome;
  startedAt?: string;
  finishedAt?: string;
  recoveredFrom?: { botId: string; botName: string; error: string };
  output?: string;
  error?: string;
  messageId?: string;
}

export interface DelegationExecutionReport {
  runId: string;
  ok: boolean;
  partial: boolean;
  roomId: string;
  roomName: string;
  tasks: DelegationTaskReport[];
  consolidatedOutput: string;
  errorSummary?: string;
  summary: {
    total: number;
    done: number;
    completed: number;
    error: number;
    failed: number;
    blocked: number;
    stopped: number;
  };
}

const PLACEHOLDER_ASSIGNEES = new Set([
  "placeholder",
  "todo",
  "tbd",
  "unknown",
  "none",
  "null",
  "undefined",
  "bot",
  "agent",
  "worker",
  "member",
  "devteam",
  "team",
  "assistant",
  "ai",
]);

function statusToOutcome(status: DelegationTaskStatus): DelegationOutcome {
  switch (status) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return status;
  }
}

/**
 * Normalize raw LLM tool input before schema validation:
 * - Unwraps alternate wrappers (`tasks`, `subtasks`, `items`, `plan`, bare array, JSON string)
 * - Generates unique task IDs (`task_1`, `task_2`, ...) when `id` is missing/blank
 * - Normalizes `dependsOn` strings/arrays
 */
export function normalizeDelegationInput(rawInput: unknown): { tasks: unknown[] } {
  let candidate: unknown = rawInput;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new InputError("Delegation input must be an object with a non-empty tasks array.");
    }
  }

  let rawTasks: unknown;
  if (Array.isArray(candidate)) {
    rawTasks = candidate;
  } else if (candidate && typeof candidate === "object") {
    const obj = candidate as Record<string, unknown>;
    rawTasks = obj.tasks ?? obj.subtasks ?? obj.items ?? obj.plan;
    if (rawTasks === undefined && typeof obj.title === "string" && typeof obj.assignee === "string") {
      rawTasks = [obj];
    }
  }

  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new InputError("Delegation requires a non-empty `tasks` array (`{ tasks: [{ id, title, instructions, assignee }] }`).");
  }

  // Reserve explicitly provided non-empty IDs first so generated IDs never collide
  // (while preserving duplicate IDs so validateDelegationPlan can reject duplicates explicitly).
  const usedIds = new Set<string>();
  for (const item of rawTasks) {
    if (item && typeof item === "object") {
      const rawId = (item as Record<string, unknown>).id;
      if (typeof rawId === "string" && rawId.trim()) {
        usedIds.add(rawId.trim());
      }
    }
  }

  let seq = 1;
  const nextUniqueId = () => {
    while (usedIds.has(`task_${seq}`)) seq += 1;
    const id = `task_${seq}`;
    usedIds.add(id);
    seq += 1;
    return id;
  };

  const normalizedTasks = rawTasks.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new InputError("Every item in `tasks` must be an object with title, instructions, and assignee.");
    }
    const t = item as Record<string, unknown>;
    const rawId = typeof t.id === "string" ? t.id.trim() : "";
    const id = rawId || nextUniqueId();

    const rawDeps = t.dependsOn ?? t.depends_on;
    let dependsOn: unknown[] = [];
    if (Array.isArray(rawDeps)) {
      dependsOn = rawDeps.map((d) => String(d ?? "").trim()).filter(Boolean);
    } else if (typeof rawDeps === "string" && rawDeps.trim()) {
      dependsOn = rawDeps
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
    }

    const assignee = t.assignee ?? t.owner ?? t.agent ?? t.bot ?? "";
    const fallbackAssignee = t.fallbackAssignee ?? t.fallback_assignee ?? t.fallback;
    const title = t.title ?? t.name ?? t.step ?? "";
    const instructions = t.instructions ?? t.description ?? t.prompt ?? t.task ?? title;

    return {
      ...t,
      id,
      title: typeof title === "string" ? title : String(title ?? ""),
      instructions: typeof instructions === "string" ? instructions : String(instructions ?? ""),
      assignee: typeof assignee === "string" ? assignee : String(assignee ?? ""),
      ...(fallbackAssignee !== undefined ? { fallbackAssignee: String(fallbackAssignee) } : {}),
      dependsOn,
    };
  });

  return { tasks: normalizedTasks };
}

/**
 * Resolve an assignee string (actual bot id, @handle, handle, name, or unique
 * role/title) strictly against the room's current members.
 */
export function resolveRoomMember(assignee: string, room: Room, members: Bot[], allBots: Bot[] = members): Bot {
  const raw = assignee.trim();
  const normalized = raw.replace(/^@+/, "").trim().toLowerCase();
  if (!normalized) {
    throw new InputError("Task assignee cannot be empty.");
  }

  const validList = members.map((m) => `${m.name} (@${m.handle}, id: ${m.id}${m.title ? `, role: ${m.title}` : ""})`).join("; ");

  // 1. Reject obvious placeholder IDs/names immediately (e.g., DevTeam1, DevTeam2, bot_1, agent-2)
  if (
    PLACEHOLDER_ASSIGNEES.has(normalized) ||
    /^(bot|agent|worker|member|devteam|team|dev|assistant|task)[_-]?\d+$/i.test(normalized)
  ) {
    throw new InputError(
      `Invalid placeholder assignee "${assignee}". Use an actual member of room "${room.name}": ${validList || "none"}.`,
    );
  }

  // 2. Exact bot ID match within room members
  const byId = members.find((m) => m.id === raw || m.id.toLowerCase() === normalized);
  if (byId) return byId;

  // 3. Exact @handle match within room members
  const byHandle = members.find((m) => m.handle.toLowerCase() === normalized);
  if (byHandle) return byHandle;

  // 4. Exact name match within room members
  const byName = members.find((m) => m.name.toLowerCase() === normalized);
  if (byName) return byName;

  // 5. Unique role/title match within room members (e.g., "Research" -> Scout)
  const byTitle = members.filter((m) => m.title.trim().toLowerCase() === normalized);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new InputError(
      `Role "${assignee}" matches multiple room members (${byTitle.map((m) => `${m.name} (@${m.handle})`).join(", ")}). Specify a bot id or @handle.`,
    );
  }

  // 6. Preserve room membership boundary: check if it matches a bot outside the room
  const outsider = allBots.find(
    (b) => b.id === raw || b.id.toLowerCase() === normalized || b.handle.toLowerCase() === normalized || b.name.toLowerCase() === normalized,
  );
  if (outsider) {
    throw new InputError(
      `Cannot delegate to ${outsider.name} (@${outsider.handle}): not a member of room "${room.name}". Valid members: ${validList || "none"}.`,
    );
  }

  throw new InputError(`Cannot identify room member "${assignee}" in room "${room.name}". Valid members: ${validList || "none"}.`);
}

function detectCycle(tasks: ResolvedDelegationTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    state.set(id, "visiting");
    stack.push(id);
    const task = byId.get(id)!;
    for (const dep of task.dependsOn) {
      const depState = state.get(dep);
      if (depState === "visiting") {
        const idx = stack.indexOf(dep);
        return [...stack.slice(idx), dep];
      }
      if (!depState) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "visited");
    return null;
  }

  for (const t of tasks) {
    if (!state.has(t.id)) {
      const cycle = dfs(t.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Validate 1-20 structured tasks, auto-fill missing IDs, validate room membership, dependencies, self-refs, and cycles. */
export function validateDelegationPlan(
  rawInput: unknown,
  room: Room,
  members: Bot[],
  allBots: Bot[] = members,
): ResolvedDelegationTask[] {
  const normalized = normalizeDelegationInput(rawInput);
  const parsed = DelegationPlanInputSchema.safeParse(normalized);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InputError(issue?.message || "Delegation must include 1-20 valid structured tasks.");
  }

  const seenIds = new Set<string>();
  const resolved: ResolvedDelegationTask[] = [];

  for (const task of parsed.data.tasks) {
    if (seenIds.has(task.id)) {
      throw new InputError(`Duplicate task ID "${task.id}". Every task in a delegation plan must have a unique ID.`);
    }
    seenIds.add(task.id);
    const assigneeBot = resolveRoomMember(task.assignee, room, members, allBots);
    const fallbackAssigneeBot = task.fallbackAssignee
      ? resolveRoomMember(task.fallbackAssignee, room, members, allBots)
      : undefined;
    resolved.push({
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      assigneeBot,
      fallbackAssigneeBot,
      dependsOn: [...new Set(task.dependsOn)],
    });
  }

  for (const task of resolved) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        throw new InputError(`Self-referential dependency: task "${task.id}" cannot depend on itself.`);
      }
      if (!seenIds.has(dep)) {
        throw new InputError(`Unknown task dependency "${dep}" referenced by task "${task.id}".`);
      }
    }
  }

  const cycle = detectCycle(resolved);
  if (cycle) {
    throw new InputError(`Circular dependency detected: ${cycle.join(" -> ")}.`);
  }

  return resolved;
}

export type WorkerTurnFn = (request: {
  bot: Bot;
  conversationId: ConversationId;
  content: string;
  route?: RouteNote;
}) => Promise<ChatMessage | null>;

function extractText(message: ChatMessage): string {
  return message.parts
    .filter((p) => p.kind === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}

function toTaskRecord(r: DelegationTaskReport): DelegationTaskRecord {
  return {
    id: r.id,
    title: r.title,
    botId: r.botId,
    botName: r.botName,
    botHandle: r.botHandle,
    dependsOn: r.dependsOn,
    status: r.status,
    outcome: r.outcome,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    recoveredFrom: r.recoveredFrom,
    output: r.output,
    error: r.error,
    messageId: r.messageId,
  };
}

/**
 * Execute validated delegation tasks in topological waves, running independent
 * tasks in parallel while passing completed dependency outputs downstream.
 */
export async function executeDelegationPlan(params: {
  room: Room;
  conversationId: ConversationId;
  tasks: ResolvedDelegationTask[];
  requestedBy: Bot;
  runWorkerTurn: WorkerTurnFn;
  isStopped: () => boolean;
  onPersist?: (record: DelegationRunRecord) => Promise<void>;
}): Promise<DelegationExecutionReport> {
  const { room, conversationId, tasks, requestedBy, runWorkerTurn, isStopped, onPersist } = params;
  const runId = randomUUID().slice(0, 12);
  const createdAt = new Date().toISOString();

  const reports = new Map<string, DelegationTaskReport>(
    tasks.map((t) => [
      t.id,
      {
        id: t.id,
        title: t.title,
        botId: t.assigneeBot.id,
        botName: t.assigneeBot.name,
        botHandle: t.assigneeBot.handle,
        dependsOn: t.dependsOn,
        status: "pending",
        outcome: "pending",
      },
    ]),
  );

  const persistSnapshot = async (finishedAt?: string, ok = false) => {
    if (!onPersist) return;
    const all = tasks.map((t) => toTaskRecord(reports.get(t.id)!));
    await onPersist({
      id: runId,
      roomId: room.id,
      roomName: room.name,
      requestedByBotId: requestedBy.id,
      createdAt,
      finishedAt,
      ok,
      tasks: all,
    }).catch(() => {});
  };

  await persistSnapshot();

  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  while (true) {
    const pending = tasks.filter((t) => reports.get(t.id)!.status === "pending");
    if (pending.length === 0) break;

    if (isStopped()) {
      const now = new Date().toISOString();
      for (const t of pending) {
        const rep = reports.get(t.id)!;
        rep.status = "stopped";
        rep.outcome = "stopped";
        rep.finishedAt = now;
        rep.error = "Stopped by user.";
      }
      await persistSnapshot();
      break;
    }

    // Mark tasks whose dependencies failed/blocked/stopped as blocked
    let blockedAny = false;
    for (const t of pending) {
      const failedDep = t.dependsOn.find((d) => {
        const s = reports.get(d)!.status;
        return s === "error" || s === "blocked" || s === "stopped";
      });
      if (failedDep) {
        const rep = reports.get(t.id)!;
        rep.status = "blocked";
        rep.outcome = "blocked";
        rep.finishedAt = new Date().toISOString();
        rep.error = `Blocked because dependency "${failedDep}" did not complete (${reports.get(failedDep)!.outcome}).`;
        blockedAny = true;
      }
    }
    if (blockedAny) {
      await persistSnapshot();
      continue;
    }

    // Ready wave: all dependencies are "done"
    const ready = pending.filter((t) => t.dependsOn.every((d) => reports.get(d)!.status === "done"));
    if (ready.length === 0) {
      for (const t of pending) {
        const rep = reports.get(t.id)!;
        rep.status = "blocked";
        rep.outcome = "blocked";
        rep.finishedAt = new Date().toISOString();
        rep.error = "Unable to schedule task due to unresolved dependencies.";
      }
      await persistSnapshot();
      break;
    }

    // Transition ready wave to running before parallel dispatch
    for (const task of ready) {
      const rep = reports.get(task.id)!;
      rep.status = "running";
      rep.outcome = "running";
      rep.startedAt = new Date().toISOString();
    }
    await persistSnapshot();

    await Promise.all(
      ready.map(async (task) => {
        const rep = reports.get(task.id)!;

        const depContext = task.dependsOn
          .map((depId) => {
            const depReport = reports.get(depId)!;
            const depTask = taskMap.get(depId)!;
            return `### Upstream task "${depTask.title}" (${depId}) by ${depReport.botName}:\n${depReport.output || "(no text output)"}`;
          })
          .join("\n\n");

        const buildPromptFor = (worker: Bot, extraNote?: string) =>
          [
            `[Delegated task in room "${room.name}" from ${requestedBy.name}]`,
            `Task (${task.id}): ${task.title}`,
            `Instructions:\n${task.instructions}`,
            depContext ? `Inputs from completed dependencies:\n${depContext}` : "",
            extraNote ?? "",
            `Respond directly as ${worker.name} with your completed work. Do not re-call delegate_tasks for this same task.`,
          ]
            .filter(Boolean)
            .join("\n\n");

        const attemptWorker = async (worker: Bot, extraNote?: string) => {
          const reply = await runWorkerTurn({
            bot: worker,
            conversationId,
            content: buildPromptFor(worker, extraNote),
            route: { by: "handoff" },
          });
          if (!reply) {
            return { status: "stopped" as const, error: "Turn cancelled before starting." };
          }
          const text = extractText(reply);
          if (reply.status === "done") {
            return { status: "done" as const, model: reply.model, messageId: reply.id, output: text || undefined };
          }
          if (reply.status === "stopped") {
            return {
              status: "stopped" as const,
              model: reply.model,
              messageId: reply.id,
              output: text || undefined,
              error: reply.error || "Stopped before completion.",
            };
          }
          return {
            status: "error" as const,
            model: reply.model,
            messageId: reply.id,
            output: text || undefined,
            error: reply.error || "Worker turn ended with an error.",
          };
        };

        try {
          let outcome = await attemptWorker(task.assigneeBot);
          if (outcome.status === "error" && task.fallbackAssigneeBot && task.fallbackAssigneeBot.id !== task.assigneeBot.id && !isStopped()) {
            const firstError = outcome.error || "Worker failed.";
            const fallback = task.fallbackAssigneeBot;
            outcome = await attemptWorker(
              fallback,
              `[Recovery notice: Primary assignee ${task.assigneeBot.name} failed (${firstError}). Complete this task as ${fallback.name}.]`,
            );
            rep.botId = fallback.id;
            rep.botName = fallback.name;
            rep.botHandle = fallback.handle;
            rep.recoveredFrom = { botId: task.assigneeBot.id, botName: task.assigneeBot.name, error: firstError };
          }

          rep.model = outcome.model;
          rep.messageId = outcome.messageId;
          if (outcome.output) rep.output = outcome.output;
          rep.status = outcome.status;
          rep.outcome = statusToOutcome(outcome.status);
          rep.finishedAt = new Date().toISOString();
          rep.error = outcome.status === "done" ? undefined : outcome.error;
        } catch (error) {
          const firstError = error instanceof Error ? error.message : String(error);
          if (task.fallbackAssigneeBot && task.fallbackAssigneeBot.id !== task.assigneeBot.id && !isStopped()) {
            const fallback = task.fallbackAssigneeBot;
            try {
              const recovered = await attemptWorker(
                fallback,
                `[Recovery notice: Primary assignee ${task.assigneeBot.name} failed (${firstError}). Complete this task as ${fallback.name}.]`,
              );
              rep.botId = fallback.id;
              rep.botName = fallback.name;
              rep.botHandle = fallback.handle;
              rep.recoveredFrom = { botId: task.assigneeBot.id, botName: task.assigneeBot.name, error: firstError };
              rep.model = recovered.model;
              rep.messageId = recovered.messageId;
              if (recovered.output) rep.output = recovered.output;
              rep.status = recovered.status;
              rep.outcome = statusToOutcome(recovered.status);
              rep.finishedAt = new Date().toISOString();
              rep.error = recovered.status === "done" ? undefined : recovered.error;
              return;
            } catch (fallbackErr) {
              rep.status = "error";
              rep.outcome = "failed";
              rep.finishedAt = new Date().toISOString();
              rep.error = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              return;
            }
          }
          rep.status = "error";
          rep.outcome = "failed";
          rep.finishedAt = new Date().toISOString();
          rep.error = firstError;
        }
      }),
    );

    await persistSnapshot();
  }

  const allReports = tasks.map((t) => reports.get(t.id)!);
  const doneCount = allReports.filter((r) => r.status === "done").length;
  const errorCount = allReports.filter((r) => r.status === "error").length;
  const blockedCount = allReports.filter((r) => r.status === "blocked").length;
  const stoppedCount = allReports.filter((r) => r.status === "stopped").length;
  const ok = errorCount === 0 && blockedCount === 0 && stoppedCount === 0 && doneCount === allReports.length;
  const partial = !ok && doneCount > 0;
  const errorDetails = allReports
    .filter((r) => r.status !== "done")
    .map((r) => `${r.id} (${r.botName}, ${r.outcome}): ${r.error ?? "did not complete"}`);

  const consolidatedOutput = allReports
    .map((r) => {
      const header = `- **[${r.outcome.toUpperCase()}] ${r.id} — ${r.title}** (@${r.botHandle}${
        r.recoveredFrom ? `, recovered from ${r.recoveredFrom.botName}` : ""
      })`;
      if (r.status === "done") return `${header}\n  ${(r.output ?? "(completed)").split("\n")[0].slice(0, 280)}`;
      return `${header}\n  Error: ${r.error ?? "failed"}`;
    })
    .join("\n");

  const finishedAt = new Date().toISOString();
  await persistSnapshot(finishedAt, ok);

  return {
    runId,
    ok,
    partial,
    roomId: room.id,
    roomName: room.name,
    tasks: allReports,
    consolidatedOutput,
    errorSummary: errorDetails.length ? errorDetails.join("; ") : undefined,
    summary: {
      total: allReports.length,
      done: doneCount,
      completed: doneCount,
      error: errorCount,
      failed: errorCount,
      blocked: blockedCount,
      stopped: stoppedCount,
    },
  };
}
