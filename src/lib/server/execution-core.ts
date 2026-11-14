import type { Bot, ChatMessage, ExecutionTask, TaskCapability } from "@/lib/shared/types";

export interface TaskPlanItem {
  id: string;
  title: string;
  description: string;
  assignedBotId: string;
  requiredCapabilities: TaskCapability[];
  dependencies: string[];
}

export interface TaskGraphOptions {
  runTask: (task: ExecutionTask, dependencyOutputs: ReadonlyMap<string, string>, signal: AbortSignal) => Promise<string>;
  onTaskUpdate: (task: ExecutionTask) => Promise<void>;
  signal: AbortSignal;
  maxRetries?: number;
  concurrency?: number;
}

export class RetryableTaskError extends Error {}

export class UnknownTaskOutcomeError extends Error {}

export class TaskPersistenceError extends Error {
  readonly taskId: string;
  readonly taskStatus: ExecutionTask["status"];
  readonly detail: unknown;

  constructor(
    taskId: string,
    taskStatus: ExecutionTask["status"],
    detail: unknown,
  ) {
    super("Task state could not be saved.");
    this.name = "TaskPersistenceError";
    this.taskId = taskId;
    this.taskStatus = taskStatus;
    this.detail = detail;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function allOrThrow(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export function validateTaskGraph(tasks: ExecutionTask[], botIds?: ReadonlySet<string>): void {
  if (tasks.length === 0 || tasks.length > 30) throw new Error("A task plan must contain between 1 and 30 tasks.");
  const byId = new Map<string, ExecutionTask>();
  for (const task of tasks) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
    if (byId.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    if (!task.title.trim() || task.title.length > 120) throw new Error(`Task ${task.id} needs a title under 120 characters.`);
    if (!task.description.trim() || task.description.length > 20_000) throw new Error(`Task ${task.id} needs a description under 20,000 characters.`);
    if (botIds && !botIds.has(task.assignedBotId)) throw new Error(`Task ${task.id} refers to an unavailable bot.`);
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
      if (!byId.has(dependency)) throw new Error(`Task ${task.id} has an unknown dependency: ${dependency}`);
      if (dependencies.has(dependency)) throw new Error(`Task ${task.id} has a duplicate dependency: ${dependency}`);
      dependencies.add(dependency);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Task dependencies contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function createExecutionTasks(plan: TaskPlanItem[], bots: Bot[], createdAt = new Date().toISOString()): ExecutionTask[] {
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  const tasks = plan.map((item): ExecutionTask => {
    const bot = botsById.get(item.assignedBotId);
    if (!bot) throw new Error(`The plan selected an unavailable bot for task "${item.title}".`);
    const unavailableCapability = item.requiredCapabilities.find((capability) => {
      switch (capability) {
        case "webSearch":
        case "memory":
        case "codeMode":
        case "browser":
        case "askUser":
          return !bot.tools[capability];
        case "connectedApps":
          return bot.connections.length === 0;
        default:
          return false;
      }
    });
    if (unavailableCapability) throw new Error(`Bot ${bot.name} does not have the ${unavailableCapability} capability required by "${item.title}".`);
    return {
      ...item,
      status: "pending",
      sideEffectsPossible: false,
      createdAt,
      retryCount: 0,
      approvalRequired: bot.approval !== "full",
    };
  });
  validateTaskGraph(tasks, new Set(botsById.keys()));
  return tasks;
}

async function update(task: ExecutionTask, callback: TaskGraphOptions["onTaskUpdate"]): Promise<void> {
  try {
    await callback({ ...task, dependencies: [...task.dependencies] });
  } catch (error) {
    throw new TaskPersistenceError(task.id, task.status, error);
  }
}

export function updateTaskForTurnProgress(task: ExecutionTask, message: ChatMessage, conversationId: string): boolean {
  const approval = message.parts.find(
    (part) => part.kind === "tool" && part.status === "awaiting-approval",
  );
  const question = message.parts.find(
    (part) => part.kind === "question" && part.answer === undefined,
  );
  const nextStatus: ExecutionTask["status"] = approval ? "awaiting_approval" : question ? "awaiting_input" : "running";
  const nextApproval =
    approval?.kind === "tool" ? { conversationId, toolCallId: approval.toolCallId } : undefined;
  const nextInput =
    question?.kind === "question"
      ? {
          conversationId,
          toolCallId: question.toolCallId,
          question: question.question,
          options: question.options,
        }
      : undefined;
  const changed =
    task.status !== nextStatus ||
    task.approvalRequest?.toolCallId !== nextApproval?.toolCallId ||
    task.inputRequest?.toolCallId !== nextInput?.toolCallId;
  task.status = nextStatus;
  task.approvalRequest = nextApproval;
  task.inputRequest = nextInput;
  return changed;
}

export function classifyToolOutcome(message: ChatMessage | undefined): "none" | "rejected" | "unknown" {
  const tools = message?.parts.filter((part) => part.kind === "tool") ?? [];
  const denied = tools.filter((part) => part.kind === "tool" && part.status === "denied");
  if (denied.length === 0) return "none";
  return denied.length === tools.length ? "rejected" : "unknown";
}

export function createKeyedLock() {
  const tails = new Map<string, Promise<void>>();
  return async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  };
}

async function raceWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Execution cancelled.");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Execution cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function executeTaskGraph(tasks: ExecutionTask[], options: TaskGraphOptions): Promise<void> {
  const maxRetries = Math.max(0, Math.min(3, options.maxRetries ?? 2));
  const concurrency = Math.max(1, options.concurrency ?? 4);

  while (tasks.some((task) => task.status === "pending")) {
    if (options.signal.aborted) {
      await allOrThrow(
        tasks
          .filter((task) => task.status === "pending" || task.status === "running" || task.status === "awaiting_approval" || task.status === "awaiting_input")
          .map(async (task) => {
            task.status = task.sideEffectsPossible ? "outcome_unknown" : "cancelled";
            task.completedAt = new Date().toISOString();
            task.error = task.sideEffectsPossible
              ? "Execution stopped after tool activity; reconcile its outcome before retrying."
              : "Execution cancelled.";
            task.approvalRequest = undefined;
            task.inputRequest = undefined;
            await update(task, options.onTaskUpdate);
          }),
      );
      return;
    }

    const pending = tasks.filter((task) => task.status === "pending");
    const failedDependencyTasks = pending.filter((task) =>
      task.dependencies.some((id) => tasks.find((dependency) => dependency.id === id)?.status !== "completed"),
    );
    const dependenciesFailed = failedDependencyTasks.filter((task) =>
      task.dependencies.some((id) => {
        const status = tasks.find((dependency) => dependency.id === id)?.status;
        return status === "failed" || status === "cancelled" || status === "outcome_unknown";
      }),
    );
    await allOrThrow(
      dependenciesFailed.map(async (task) => {
        task.status = "failed";
        task.error = "A required dependency did not complete.";
        task.completedAt = new Date().toISOString();
        await update(task, options.onTaskUpdate);
      }),
    );

    const ready = tasks.filter(
      (task) => task.status === "pending" && task.dependencies.every((id) => tasks.find((dependency) => dependency.id === id)?.status === "completed"),
    );
    if (!ready.length) {
      if (tasks.some((task) => task.status === "pending")) throw new Error("The task plan cannot make progress.");
      return;
    }

    for (let offset = 0; offset < ready.length; offset += concurrency) {
      const batch = ready.slice(offset, offset + concurrency);
      if (options.signal.aborted) break;
      for (const task of batch) {
        task.status = "running";
        task.startedAt ??= new Date().toISOString();
        task.error = undefined;
        task.approvalRequest = undefined;
        task.inputRequest = undefined;
      }
      try {
        await allOrThrow(batch.map((task) => update(task, options.onTaskUpdate)));
      } catch (error) {
        for (const task of batch) {
          if (task.status === "running") {
            task.status = "failed";
            task.error = "Task was not started because its status could not be saved.";
            task.completedAt = new Date().toISOString();
          }
        }
        throw error;
      }

      await allOrThrow(
        batch.map(async (task) => {
          while (true) {
            if (options.signal.aborted) {
              task.status = task.sideEffectsPossible ? "outcome_unknown" : "cancelled";
              task.error = task.sideEffectsPossible
                ? "Execution stopped after tool activity; reconcile its outcome before retrying."
                : "Execution cancelled.";
              task.completedAt = new Date().toISOString();
              task.approvalRequest = undefined;
              task.inputRequest = undefined;
              await update(task, options.onTaskUpdate);
              return;
            }
            let output: string;
            try {
              const outputs = new Map(
                task.dependencies.map((id) => [id, tasks.find((dependency) => dependency.id === id)?.output ?? ""]),
              );
              output = await raceWithAbort(() => options.runTask(task, outputs, options.signal), options.signal);
              if (options.signal.aborted) throw new Error("Execution cancelled.");
            } catch (error) {
              if (options.signal.aborted) {
                task.status = task.sideEffectsPossible ? "outcome_unknown" : "cancelled";
                task.error = task.sideEffectsPossible
                  ? "Execution stopped after tool activity; reconcile its outcome before retrying."
                  : "Execution cancelled.";
                task.completedAt = new Date().toISOString();
                task.approvalRequest = undefined;
                task.inputRequest = undefined;
                await update(task, options.onTaskUpdate);
                return;
              }
              task.error = errorText(error);
              if (error instanceof UnknownTaskOutcomeError) {
                task.status = "outcome_unknown";
                task.error = "The task may have performed an external action; reconcile its outcome before retrying.";
                task.completedAt = new Date().toISOString();
                await update(task, options.onTaskUpdate);
                return;
              }
              if (!(error instanceof RetryableTaskError) || task.retryCount >= maxRetries) {
                task.status = "failed";
                task.completedAt = new Date().toISOString();
                await update(task, options.onTaskUpdate);
                return;
              }
              task.retryCount += 1;
              await update(task, options.onTaskUpdate);
              continue;
            }

            task.output = output;
            task.error = undefined;
            task.status = "completed";
            task.completedAt = new Date().toISOString();
            try {
              await update(task, options.onTaskUpdate);
            } catch (error) {
              task.status = "outcome_unknown";
              task.error = "The task completed but its result could not be saved; reconcile its outcome before retrying.";
              throw new TaskPersistenceError(task.id, task.status, error);
            }
            return;
          }
        }),
      );
    }
  }
}
