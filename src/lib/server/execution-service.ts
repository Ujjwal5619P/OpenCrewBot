import type { Bot, ChatMessage, Execution, ExecutionTask, ModelTaskType, ScheduledWorkflowPlan } from "@/lib/shared/types";
import { randomUUID } from "node:crypto";
import type { CollaborationMessage, CollaborationTaskSpec } from "@/lib/shared/types";
import { verificationVerdict } from "./collaboration-core";
import { InputError } from "./errors";
import * as store from "./db";
import { planExecution } from "./chief-of-staff";
import {
  classifyToolOutcome,
  createExecutionTasks,
  executeTaskGraph,
  RetryableTaskError,
  TaskPersistenceError,
  UnknownTaskOutcomeError,
  updateTaskForTurnProgress,
} from "./execution-core";
import { runTurn, stopConversation } from "./runtime";
import { toolCategory } from "./tools";
import { listModelCatalog } from "./models";

const TASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRIES = 2;
const MAX_PARALLEL_TASKS = 4;

interface ExecutionControl {
  execution: Execution;
  controller: AbortController;
  persistChain: Promise<void>;
  sharedTaskOutputs: Set<string>;
  promise?: Promise<void>;
}

interface ExecutionState {
  active: Map<string, ExecutionControl>;
}

const globalState = globalThis as unknown as { __opencrewbotExecutions?: ExecutionState };
const state = (globalState.__opencrewbotExecutions ??= { active: new Map() });

function taskConversationId(executionId: string, taskId: string): string {
  return `execution:${executionId}:task:${taskId}`;
}

function persist(control: ExecutionControl): Promise<void> {
  const next = control.persistChain.catch(() => {}).then(() => store.saveExecution(control.execution));
  control.persistChain = next;
  return next;
}

function messageOutput(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function modelTaskFor(task: ExecutionTask): ModelTaskType {
  const capabilities = new Set(task.requiredCapabilities);
  if (capabilities.has("codeMode") || /\b(code|implement|program|script)\b/i.test(task.title + " " + task.description)) return "coding";
  if (capabilities.has("analysis") || /\b(data|analy[sz]e|metrics|statistics)\b/i.test(task.title + " " + task.description)) return "data_analysis";
  if (capabilities.has("research") || capabilities.has("webSearch")) return "research";
  if (capabilities.has("planning")) return "planning";
  return "general";
}

async function runAssignedTask(
  execution: Execution,
  task: ExecutionTask,
  dependencyOutputs: ReadonlyMap<string, string>,
  signal: AbortSignal,
  onTaskUpdate: () => Promise<void>,
): Promise<string> {
  let bot: Bot | null;
  try {
    bot = await store.getBot(task.assignedBotId);
  } catch (error) {
    console.error("[opencrewbot] Could not load the bot for an execution task.", error);
    throw new Error("The assigned bot could not be loaded.");
  }
  if (!bot) throw new Error(`Assigned bot ${task.assignedBotId} is no longer available.`);
  if (execution.collaboration) {
    const room = await store.getRoom(execution.collaboration.roomId);
    if (!room || !room.memberIds.includes(bot.id)) {
      throw new Error("The assigned bot is no longer a member of the collaboration room.");
    }
  }
  if (signal.aborted) throw new Error("Execution cancelled.");

  const context = task.dependencies
    .map((id) => {
      const dependency = execution.tasks.find((candidate) => candidate.id === id);
      return `### ${dependency?.title ?? id}\n${dependencyOutputs.get(id) ?? ""}`;
    })
    .join("\n\n");
  const collaborationContext = execution.collaboration
    ? await (async () => {
        const [room, messages] = await Promise.all([
          store.getRoom(execution.collaboration!.roomId),
          store.listCollaborationMessages(execution.collaboration!.roomId, 30),
        ]);
        const members = room
          ? await Promise.all(room.memberIds.map((id) => store.getBot(id)))
          : [];
        return {
          roster: members
            .filter((member): member is Bot => Boolean(member))
            .map((member) => `${member.name} (ID: ${member.id}${member.id === bot.id ? ", you" : ""})`)
            .join("\n"),
          messages: messages.map((message) => `[${message.type}] ${message.content.slice(0, 1200)}`).join("\n"),
        };
      })()
    : undefined;
  const content = [
    `[OpenCrewBot task: ${task.title}]`,
    `Original request: ${execution.instruction}`,
    task.collaboration
      ? [
          `Objective: ${task.collaboration.objective}`,
          `Context: ${task.collaboration.context}`,
          `Expected output: ${task.collaboration.expectedOutput}`,
        ].join("\n")
      : `Task instructions: ${task.description}`,
    context ? `Completed dependency outputs:\n${context}` : "",
    collaborationContext?.roster ? `Room members:\n${collaborationContext.roster}` : "",
    collaborationContext?.messages ? `Room collaboration context:\n${collaborationContext.messages}` : "",
    task.collaboration?.verificationOfTaskId
      ? "This is an independent verification. Begin your response with exactly one verdict line: VERDICT: ACCEPTED or VERDICT: NEEDS_REVISION. Base the verdict only on the evidence provided."
      : "",
    "Complete only this task. Follow your configured tools and permissions. Return your result clearly.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const conversationId = taskConversationId(execution.id, task.id);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted!: (error: Error) => void;
  let rejectTimeout!: (error: Error) => void;
  let latestMessage: ChatMessage | undefined;
  let runTurnStarted = false;
  let timedOut = false;
  let timeoutPaused = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  const pauseTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
      timeoutPaused = true;
    }
  };
  const armTimeout = () => {
    if (timeout || signal.aborted || timedOut) return;
    timeout = setTimeout(() => {
      timeout = undefined;
      timedOut = true;
      if (runTurnStarted) void stopConversation(conversationId).catch((error) => console.error("[opencrewbot] Could not stop a timed-out task.", error));
      rejectTimeout(
        runTurnStarted
          ? new UnknownTaskOutcomeError("Task timed out; reconcile its outcome before retrying.")
          : new Error("Task timed out while waiting for the bot's browser."),
      );
    }, TASK_TIMEOUT_MS);
  };
  const onProgress = (message: ChatMessage) => {
    latestMessage = message;
    if (
      message.parts.some(
        (part) =>
          part.kind === "tool" &&
          part.status !== "denied" &&
          (part.name === "execute_typescript" || toolCategory(part.name) !== "read"),
      )
    ) {
      task.sideEffectsPossible = true;
    }
    const changed = updateTaskForTurnProgress(task, message, conversationId);
    if (task.status === "awaiting_approval" || task.status === "awaiting_input") pauseTimeout();
    else if (timeoutPaused) {
      timeoutPaused = false;
      armTimeout();
    }
    if (changed) {
      void onTaskUpdate().catch((error) => console.error("[opencrewbot] Could not save task approval progress.", error));
    }
  };
  const abortHandler = () => {
    void stopConversation(conversationId).catch((error) => console.error("[opencrewbot] Could not stop a cancelled task.", error));
    rejectInterrupted(new Error("Execution cancelled."));
  };
  if (signal.aborted) abortHandler();
  else signal.addEventListener("abort", abortHandler, { once: true });
  armTimeout();

  try {
    if (signal.aborted || timedOut) throw new Error("Execution cancelled.");
    runTurnStarted = true;
    const turn = runTurn({ bot, conversationId, content, modelTask: modelTaskFor(task), onProgress });
    const reply = await Promise.race([turn, interrupted, timeoutPromise]);
    if (!reply) throw new Error("The task was stopped before it started.");
    const toolOutcome = classifyToolOutcome(reply);
    if (toolOutcome === "unknown") {
      throw new UnknownTaskOutcomeError("The task stopped after both approved and rejected tool activity.");
    }
    if (toolOutcome === "rejected") throw new Error("A required action was rejected.");
    if (reply.status !== "done") {
      if (task.sideEffectsPossible) throw new UnknownTaskOutcomeError("The bot stopped after tool activity.");
      if (reply.status === "error") throw new RetryableTaskError("The bot encountered an error before any external action.");
      throw new Error(`The bot finished with status "${reply.status}".`);
    }
    const output = messageOutput(reply);
    if (!output) {
      if (task.sideEffectsPossible) throw new UnknownTaskOutcomeError("The bot returned no result after tool activity.");
      throw new RetryableTaskError("The bot completed without returning text output.");
    }
    if (task.collaboration?.verificationOfTaskId) {
      task.collaboration.verificationStatus = verificationVerdict(output);
    }
    return output;
  } catch (error) {
    if (runTurnStarted && !signal.aborted && !timedOut) {
      await stopConversation(conversationId).catch((stopError) => console.error("[opencrewbot] Could not stop a failed task.", stopError));
    }
    const toolOutcome = classifyToolOutcome(latestMessage);
    if (toolOutcome === "rejected") throw new Error("A required action was rejected.");
    if (toolOutcome === "unknown") {
      throw new UnknownTaskOutcomeError("The task stopped after both approved and rejected tool activity.");
    }
    if (signal.aborted && task.sideEffectsPossible) {
      throw new UnknownTaskOutcomeError("Execution stopped after tool activity; reconcile its outcome before retrying.");
    }
    if (latestMessage && task.sideEffectsPossible && !(error instanceof UnknownTaskOutcomeError)) {
      throw new UnknownTaskOutcomeError("The bot run failed after tool activity; reconcile its outcome before retrying.");
    }
    if (error instanceof UnknownTaskOutcomeError || error instanceof RetryableTaskError) throw error;
    if (signal.aborted || timedOut) throw error;
    throw new RetryableTaskError("The bot run failed before any external action.");
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", abortHandler);
  }
}

function consolidatedOutput(execution: Execution): string {
  return execution.tasks
    .filter((task) => task.status === "completed" && task.output)
    .map((task) => `## ${task.title}\n${task.output}`)
    .join("\n\n")
    .slice(0, 50_000);
}

async function runExecution(control: ExecutionControl): Promise<void> {
  const { execution } = control;
  if (!(await store.claimExecution(execution.id))) return;
  execution.status = "running";
  execution.startedAt = new Date().toISOString();

  try {
    await persist(control);
    await executeTaskGraph(execution.tasks, {
      signal: control.controller.signal,
      maxRetries: MAX_RETRIES,
      concurrency: MAX_PARALLEL_TASKS,
      runTask: (task, outputs, signal) => runAssignedTask(execution, task, outputs, signal, () => persist(control)),
      onTaskUpdate: async () => {
        await persist(control);
        if (!execution.collaboration) return;
        for (const task of execution.tasks) {
          if (task.status !== "completed" || !task.output || control.sharedTaskOutputs.has(task.id)) continue;
          control.sharedTaskOutputs.add(task.id);
          const output = task.output.length > 20_000
            ? `${task.output.slice(0, 20_000)}\n[Truncated; the full output is stored on the task.]`
            : task.output;
          try {
            await store.saveCollaborationMessage({
              id: `task-output:${execution.id}:${task.id}`,
              roomId: execution.collaboration.roomId,
              executionId: execution.id,
              taskId: task.id,
              type: "task_output",
              authorBotId: task.assignedBotId,
              content: output,
              createdAt: new Date().toISOString(),
            });
          } catch (error) {
            control.sharedTaskOutputs.delete(task.id);
            console.error("[opencrewbot] Could not share a completed room task output.", error);
          }
        }
      },
    });
    const verificationMessages: CollaborationMessage[] = execution.tasks.flatMap((task) => {
      if (task.status !== "completed" || !task.collaboration?.verificationOfTaskId || !execution.collaboration) return [];
      const status = task.collaboration.verificationStatus ?? "inconclusive";
      return [{
        id: randomUUID(),
        roomId: execution.collaboration.roomId,
        executionId: execution.id,
        taskId: task.id,
        type: "verification_result",
        authorBotId: task.assignedBotId,
        content: `Review of task ${task.collaboration.verificationOfTaskId}: ${status.replace("_", " ")}.\n\n${task.output ?? ""}`,
        createdAt: new Date().toISOString(),
      }];
    });
    for (const message of verificationMessages) await store.saveCollaborationMessage(message);
    execution.output = consolidatedOutput(execution);
    execution.status = control.controller.signal.aborted
      ? "cancelled"
      : execution.tasks.some((task) => task.status === "failed")
        ? "failed"
        : execution.tasks.some((task) => task.status === "outcome_unknown")
          ? "failed"
        : execution.tasks.some((task) => task.status === "cancelled")
          ? "cancelled"
          : "completed";
    if (execution.status === "cancelled") execution.error = "Execution cancelled.";
    else if (execution.tasks.some((task) => task.status === "outcome_unknown")) {
      execution.error = "One or more task outcomes require reconciliation before retrying.";
    } else if (execution.status === "failed") {
      execution.error = "One or more tasks failed.";
    }
    execution.completedAt = new Date().toISOString();
    await persist(control);
  } catch (error) {
    if (error instanceof TaskPersistenceError) {
      const task = execution.tasks.find((candidate) => candidate.id === error.taskId);
      if (task && task.status !== "outcome_unknown") {
        task.status = task.sideEffectsPossible ? "outcome_unknown" : "failed";
        task.error = task.sideEffectsPossible
          ? "Task state could not be saved after tool activity; reconcile its outcome before retrying."
          : "Task state could not be saved; the task was not retried.";
        task.completedAt = new Date().toISOString();
      }
    }
    for (const task of execution.tasks) {
      if (task.status === "running" || task.status === "awaiting_approval" || task.status === "awaiting_input") {
        task.status = task.sideEffectsPossible ? "outcome_unknown" : "failed";
        task.error = task.sideEffectsPossible
          ? "Execution stopped after tool activity; reconcile its outcome before retrying."
          : "Execution stopped before the task could be confirmed.";
        task.completedAt = new Date().toISOString();
        task.approvalRequest = undefined;
        task.inputRequest = undefined;
      }
    }
    execution.status = control.controller.signal.aborted ? "cancelled" : "failed";
    execution.error = control.controller.signal.aborted
      ? "Execution cancelled."
      : error instanceof TaskPersistenceError
        ? "Task state could not be saved; reconcile any task with an unknown outcome before retrying."
        : "Execution failed because of an internal error.";
    execution.completedAt = new Date().toISOString();
    await persist(control);
    if (!control.controller.signal.aborted) throw error;
  }
}

function launchExecution(execution: Execution): void {
  if (state.active.has(execution.id) || execution.status !== "pending") return;
  const control: ExecutionControl = {
    execution,
    controller: new AbortController(),
    persistChain: Promise.resolve(),
    sharedTaskOutputs: new Set(),
  };
  state.active.set(execution.id, control);
  control.promise = runExecution(control)
    .catch((error: unknown) => {
      console.error("[opencrewbot] Task execution failed.", error);
    })
    .finally(() => {
      if (state.active.get(execution.id) === control) state.active.delete(execution.id);
    });
}

export async function createExecutionFromPlan(
  plan: ScheduledWorkflowPlan,
  options: { id?: string; scheduleId?: string; createdAt?: string } = {},
): Promise<Execution> {
  const bots = await store.listBots();
  let tasks: ExecutionTask[];
  try {
    tasks = createExecutionTasks(plan.tasks, bots);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "The saved workflow plan is no longer valid.");
  }
  const execution: Execution = {
    id: options.id ?? randomUUID(),
    instruction: plan.instruction,
    summary: plan.summary,
    plannerMode: plan.plannerMode,
    plannerLabel: plan.plannerLabel,
    status: "pending",
    tasks,
    scheduleId: options.scheduleId,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  await store.saveExecution(execution);
  launchExecution(execution);
  return execution;
}

export async function createExecution(instruction: unknown): Promise<Execution> {
  const planned = await planExecution(instruction);
  return createExecutionFromPlan(
    {
      instruction: planned.instruction,
      summary: planned.summary,
      plannerMode: planned.plannerMode,
      plannerLabel: planned.plannerLabel,
      tasks: planned.tasks.map(({ id, title, description, assignedBotId, requiredCapabilities, dependencies }) => ({
        id,
        title,
        description,
        assignedBotId,
        requiredCapabilities,
        dependencies,
      })),
    },
    { id: planned.id, createdAt: planned.createdAt },
  );
}

export async function createDelegatedExecution(input: {
  roomId: string;
  instruction: string;
  summary: string;
  tasks: CollaborationTaskSpec[];
  metadata: NonNullable<Execution["collaboration"]>;
  messages: CollaborationMessage[];
  parentSignal?: AbortSignal;
}): Promise<Execution> {
  if (input.parentSignal?.aborted) throw new InputError("The parent task was cancelled.");
  const bots = (await store.getRoom(input.roomId))?.memberIds ?? [];
  if (!bots.length) throw new InputError("The room has no available members.");
  const members = (await Promise.all(bots.map((id) => store.getBot(id)))).filter((bot): bot is Bot => Boolean(bot));
  const taskPlan = input.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: `${task.objective}\n\nContext: ${task.context}\n\nExpected output: ${task.expectedOutput}`,
    assignedBotId: task.assignedBotId,
    requiredCapabilities: [],
    dependencies: task.dependencies,
  }));
  let tasks: ExecutionTask[];
  try {
    tasks = createExecutionTasks(taskPlan, members);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "The delegated task plan is invalid.");
  }
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  for (const task of input.tasks) {
    if (!members.some((member) => member.id === task.assignedBotId)) {
      throw new InputError(`Task ${task.id} must be assigned to a member of this room.`);
    }
    if (task.verificationOfTaskId) {
      if (!taskById.has(task.verificationOfTaskId) || !task.dependencies.includes(task.verificationOfTaskId)) {
        throw new InputError(`Verification task ${task.id} must depend on the task it reviews.`);
      }
    }
  }
  for (const task of tasks) {
    const spec = taskById.get(task.id)!;
    task.collaboration = {
      objective: spec.objective,
      context: spec.context,
      expectedOutput: spec.expectedOutput,
      verificationOfTaskId: spec.verificationOfTaskId,
    };
  }
  const catalog = await listModelCatalog();
  const simulated = !catalog.providers.some((provider) => provider.available);
  const createdAt = new Date().toISOString();
  const execution: Execution = {
    id: randomUUID(),
    instruction: input.instruction,
    summary: input.summary,
    plannerMode: simulated ? "simulated" : "ai",
    plannerLabel: simulated ? "Agent delegation (simulated mode)" : "Agent delegation",
    status: "pending",
    tasks,
    createdAt,
    collaboration: input.metadata,
  };
  if (input.parentSignal?.aborted) throw new InputError("The parent task was cancelled.");
  try {
    await store.saveExecution(execution, input.messages.map((message) => ({ ...message, executionId: execution.id })));
  } catch (error) {
    if (
      input.metadata.patternKey &&
      error instanceof Error &&
      /unique constraint|sqlite_constraint/i.test(error.message) &&
      (await store.hasActiveRoomPattern(input.roomId, input.metadata.patternKey))
    ) {
      throw new InputError("An identical delegation is already active in this room.");
    }
    throw error;
  }
  if (input.parentSignal?.aborted) {
    await cancelExecution(execution.id);
    throw new InputError("The parent task was cancelled.");
  }
  launchExecution(execution);
  return execution;
}

export async function getExecution(id: string): Promise<Execution> {
  const execution = state.active.get(id)?.execution ?? (await store.getExecution(id));
  if (!execution) throw new InputError("That execution doesn't exist.");
  return execution;
}

export async function listExecutionHistory(): Promise<Execution[]> {
  const executions = await store.listExecutions();
  return executions.map((execution) => state.active.get(execution.id)?.execution ?? execution);
}

async function cancelDescendantExecutions(executionId: string): Promise<void> {
  for (const child of await store.listChildExecutions(executionId)) {
    if (["completed", "failed", "cancelled"].includes(child.status)) continue;
    await cancelExecution(child.id);
  }
}

export async function cancelExecution(id: string): Promise<Execution> {
  const control = state.active.get(id);
  const execution = control?.execution ?? (await store.getExecution(id));
  if (!execution) throw new InputError("That execution doesn't exist.");
  if (["completed", "failed", "cancelled"].includes(execution.status)) return execution;

  if (control) {
    control.controller.abort();
    await cancelDescendantExecutions(id);
    for (const task of control.execution.tasks) {
      if (task.status === "pending") {
        task.status = "cancelled";
        task.error = "Execution cancelled.";
        task.completedAt = new Date().toISOString();
      }
    }
    await persist(control);
    await control.promise;
    return control.execution;
  }

  execution.status = "cancelled";
  execution.error = "Execution cancelled.";
  execution.completedAt = new Date().toISOString();
  await cancelDescendantExecutions(id);
  for (const task of execution.tasks) {
    if (task.status === "pending" || task.status === "running" || task.status === "awaiting_approval" || task.status === "awaiting_input") {
      task.status = task.sideEffectsPossible || task.status !== "pending" ? "outcome_unknown" : "cancelled";
      task.error = task.status === "outcome_unknown"
        ? "Execution stopped after tool activity; reconcile its outcome before retrying."
        : "Execution cancelled.";
      task.completedAt = new Date().toISOString();
      task.approvalRequest = undefined;
      task.inputRequest = undefined;
    }
  }
  await store.saveExecution(execution);
  return execution;
}

export async function recoverTaskExecutions(): Promise<void> {
  await store.recoverInterruptedExecutions();
  for (const execution of await store.pendingExecutions()) launchExecution(execution);
}
