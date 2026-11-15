import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Execution,
  ScheduledWorkflow,
  ScheduledWorkflowPlan,
  ScheduledWorkflowRun,
  ScheduledWorkflowRunStatus,
  WorkflowRecurrence,
} from "@/lib/shared/types";
import { InputError } from "./errors";
import * as store from "./db";
import { createKeyedLock } from "./execution-core";
import { createExecutionFromPlan } from "./execution-service";
import { planExecution } from "./chief-of-staff";
import { nextScheduledOccurrence, nextWorkflowRun, zonedLocalDateTimeToUtc } from "./schedule-core";

const MISSED_RUN_GRACE_MS = 5 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 15 * 1000;
const MAX_SCHEDULES = 50;

const DraftSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    instruction: z.string().trim().min(1).max(20_000),
    recurrence: z.enum(["once", "daily", "weekly"]),
    timeZone: z.string().trim().min(1).max(100),
    localTime: z.string().optional(),
    oneTimeLocal: z.string().optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .strict();

type ScheduleDraft = z.infer<typeof DraftSchema>;
type ExecutionFactory = typeof createExecutionFromPlan;

interface SchedulerState {
  withScheduleLock: ReturnType<typeof createKeyedLock>;
  timer?: ReturnType<typeof setInterval>;
  tick?: Promise<void>;
}

const globalState = globalThis as unknown as { __opencrewbotScheduler?: SchedulerState };
const schedulerState = (globalState.__opencrewbotScheduler ??= { withScheduleLock: createKeyedLock() });

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeDraft(raw: unknown, now: Date): ScheduleDraft & { localTime: string; weekdays: number[] } {
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) throw new InputError("Provide a valid scheduled workflow name, instruction, and schedule.");
  const draft = parsed.data;
  if (!isValidTimeZone(draft.timeZone)) throw new InputError("Choose a valid IANA timezone.");

  if (draft.recurrence === "once") {
    if (!draft.oneTimeLocal || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(draft.oneTimeLocal)) {
      throw new InputError("Choose a valid local date and time for a one-time workflow.");
    }
    const instant = zonedLocalDateTimeToUtc(draft.oneTimeLocal, draft.timeZone);
    if (!instant) throw new InputError("That local time does not exist in the selected timezone.");
    if (instant.getTime() <= now.getTime()) throw new InputError("One-time schedules must be in the future.");
    return { ...draft, localTime: draft.oneTimeLocal.slice(-5), weekdays: [] };
  }

  if (!draft.localTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.localTime)) {
    throw new InputError("Choose a valid local time for the recurring workflow.");
  }
  const weekdays = draft.recurrence === "weekly" ? draft.weekdays ?? [] : [];
  if (draft.recurrence === "weekly" && weekdays.length === 0) {
    throw new InputError("Choose at least one weekday for a weekly workflow.");
  }
  if (new Set(weekdays).size !== weekdays.length) throw new InputError("Weekly weekdays must not be repeated.");
  return { ...draft, localTime: draft.localTime, weekdays };
}

function planSnapshot(execution: Execution): ScheduledWorkflowPlan {
  return {
    instruction: execution.instruction,
    summary: execution.summary,
    plannerMode: execution.plannerMode,
    plannerLabel: execution.plannerLabel,
    tasks: execution.tasks.map(({ id, title, description, assignedBotId, requiredCapabilities, dependencies }) => ({
      id,
      title,
      description,
      assignedBotId,
      requiredCapabilities,
      dependencies,
    })),
  };
}

function firstRunAt(timing: {
  recurrence: WorkflowRecurrence;
  timeZone: string;
  localTime: string;
  oneTimeLocal?: string;
  weekdays: number[];
}, after: Date): string {
  const next = nextScheduledOccurrence(timing, after);
  if (!next) throw new InputError("The workflow has no valid future run time.");
  return next.toISOString();
}

function statusFromExecution(execution: Execution): ScheduledWorkflowRunStatus {
  if (execution.status === "pending" || execution.status === "running") return "running";
  if (execution.status === "completed") return "completed";
  if (execution.status === "cancelled") return "cancelled";
  return execution.tasks.some((task) => task.status === "outcome_unknown") ? "outcome_unknown" : "failed";
}

async function getWorkflow(id: string): Promise<ScheduledWorkflow> {
  const workflow = await store.getScheduledWorkflow(id);
  if (!workflow || workflow.status === "deleted") throw new InputError("That scheduled workflow doesn't exist.");
  return workflow;
}

export async function listWorkflows(): Promise<ScheduledWorkflow[]> {
  return store.listScheduledWorkflows();
}

export async function listWorkflowRuns(
  workflowId?: string,
  limit = 200,
  offset = 0,
): Promise<ScheduledWorkflowRun[]> {
  if (workflowId && !(await store.getScheduledWorkflow(workflowId))) {
    throw new InputError("That scheduled workflow doesn't exist.");
  }
  return store.listScheduledWorkflowRuns(workflowId, limit, false, offset);
}

export async function createWorkflow(raw: unknown, suppliedNow?: Date): Promise<ScheduledWorkflow> {
  const now = suppliedNow ?? new Date();
  const draft = normalizeDraft(raw, now);
  if ((await store.listScheduledWorkflows()).length >= MAX_SCHEDULES) {
    throw new InputError(`A maximum of ${MAX_SCHEDULES} scheduled workflows is supported.`);
  }
  const planned = await planExecution(draft.instruction);
  const createdAt = (suppliedNow ?? new Date()).toISOString();
  const workflow: ScheduledWorkflow = {
    id: randomUUID(),
    name: draft.name,
    recurrence: draft.recurrence,
    timeZone: draft.timeZone,
    localTime: draft.localTime,
    oneTimeLocal: draft.recurrence === "once" ? draft.oneTimeLocal : undefined,
    weekdays: draft.weekdays,
    status: "active",
    nextRunAt: firstRunAt(draft, suppliedNow ?? new Date()),
    plan: planSnapshot(planned),
    createdAt,
    updatedAt: createdAt,
  };
  await store.saveScheduledWorkflow(workflow);
  return workflow;
}

export async function updateWorkflow(id: string, raw: unknown, suppliedNow?: Date): Promise<ScheduledWorkflow> {
  return schedulerState.withScheduleLock(id, async () => {
    const now = suppliedNow ?? new Date();
    const current = await getWorkflow(id);
    const draft = normalizeDraft(raw, now);
    const plan =
      draft.instruction === current.plan.instruction
        ? current.plan
        : planSnapshot(await planExecution(draft.instruction));
    const effectiveNow = suppliedNow ?? new Date();
    const workflow: ScheduledWorkflow = {
      ...current,
      name: draft.name,
      recurrence: draft.recurrence,
      timeZone: draft.timeZone,
      localTime: draft.localTime,
      oneTimeLocal: draft.recurrence === "once" ? draft.oneTimeLocal : undefined,
      weekdays: draft.weekdays,
      status: current.status === "paused" ? "paused" : "active",
      nextRunAt: firstRunAt(draft, effectiveNow),
      plan,
      updatedAt: effectiveNow.toISOString(),
    };
    await store.saveScheduledWorkflow(workflow);
    return workflow;
  });
}

export async function pauseWorkflow(id: string, now = new Date()): Promise<ScheduledWorkflow> {
  return schedulerState.withScheduleLock(id, async () => {
    const workflow = await getWorkflow(id);
    if (workflow.status === "completed") throw new InputError("That one-time workflow has already run.");
    if (workflow.status === "paused") return workflow;
    workflow.status = "paused";
    workflow.updatedAt = now.toISOString();
    await store.saveScheduledWorkflow(workflow);
    return workflow;
  });
}

export async function resumeWorkflow(id: string, now = new Date()): Promise<ScheduledWorkflow> {
  return schedulerState.withScheduleLock(id, async () => {
    const workflow = await getWorkflow(id);
    if (workflow.status !== "paused") throw new InputError("That workflow is not paused.");
    workflow.nextRunAt = firstRunAt(workflow, now);
    workflow.status = "active";
    workflow.updatedAt = now.toISOString();
    await store.saveScheduledWorkflow(workflow);
    return workflow;
  });
}

export async function deleteWorkflow(id: string, now = new Date()): Promise<ScheduledWorkflow> {
  return schedulerState.withScheduleLock(id, async () => {
    await synchronizeRuns(id);
    const workflow = await getWorkflow(id);
    if (await store.getActiveScheduledWorkflowRun(id)) {
      throw new InputError("A workflow with an active execution cannot be deleted.");
    }
    workflow.status = "deleted";
    workflow.nextRunAt = null;
    workflow.updatedAt = now.toISOString();
    await store.saveScheduledWorkflow(workflow);
    return workflow;
  });
}

function newRun(
  workflow: ScheduledWorkflow,
  occurrenceKey: string,
  scheduledFor: string,
  now: Date,
  status: ScheduledWorkflowRun["status"],
): ScheduledWorkflowRun {
  return {
    id: randomUUID(),
    workflowId: workflow.id,
    occurrenceKey,
    scheduledFor,
    executionId: status === "claimed" ? randomUUID() : undefined,
    status,
    createdAt: now.toISOString(),
    plan: workflow.plan,
  };
}

async function advanceSchedule(
  workflow: ScheduledWorkflow,
  occurrenceAt: Date,
  now: Date,
  missed: boolean,
): Promise<void> {
  if (workflow.recurrence === "once") {
    workflow.status = "completed";
    workflow.nextRunAt = null;
  } else {
    const next = nextWorkflowRun(workflow, missed ? now : occurrenceAt);
    if (!next) throw new Error("Could not calculate the next scheduled workflow occurrence.");
    workflow.nextRunAt = next.toISOString();
  }
  workflow.updatedAt = now.toISOString();
  await store.saveScheduledWorkflow(workflow);
}

async function recordSkipped(
  workflow: ScheduledWorkflow,
  occurrenceAt: Date,
  now: Date,
  error: string,
): Promise<void> {
  const run = newRun(workflow, occurrenceAt.toISOString(), occurrenceAt.toISOString(), now, "skipped");
  run.error = error;
  run.completedAt = now.toISOString();
  await store.claimScheduledWorkflowRun(run);
}

async function launchClaimedRun(
  workflow: ScheduledWorkflow,
  run: ScheduledWorkflowRun,
  now: Date,
  createExecution: ExecutionFactory,
): Promise<Execution | null> {
  if (!run.executionId) throw new Error("A claimed workflow run has no execution identifier.");
  try {
    const execution = await createExecution(run.plan, { id: run.executionId, scheduleId: workflow.id });
    if (execution.id !== run.executionId || execution.scheduleId !== workflow.id) {
      throw new Error("The execution service returned a mismatched scheduled execution.");
    }
    run.status = statusFromExecution(execution);
    run.startedAt = execution.startedAt ?? execution.createdAt;
    run.completedAt = execution.completedAt;
    run.error = execution.error;
    await store.saveScheduledWorkflowRun(run);
    const latest = await store.getScheduledWorkflow(workflow.id);
    if (latest) {
      latest.lastRunAt = now.toISOString();
      latest.lastExecutionId = execution.id;
      latest.updatedAt = now.toISOString();
      await store.saveScheduledWorkflow(latest);
    }
    return execution;
  } catch (error) {
    const existing = await store.getExecution(run.executionId);
    if (existing?.scheduleId === workflow.id) {
      run.status = statusFromExecution(existing);
      run.startedAt = existing.startedAt ?? existing.createdAt;
      run.completedAt = existing.completedAt;
      run.error = existing.error;
      await store.saveScheduledWorkflowRun(run);
      const latest = await store.getScheduledWorkflow(workflow.id);
      if (latest) {
        latest.lastRunAt = now.toISOString();
        latest.lastExecutionId = existing.id;
        latest.updatedAt = now.toISOString();
        await store.saveScheduledWorkflow(latest);
      }
      return existing;
    }
    run.status = "failed";
    run.error = error instanceof InputError ? error.message : "The workflow execution could not be created.";
    run.completedAt = now.toISOString();
    await store.saveScheduledWorkflowRun(run);
    const latest = await store.getScheduledWorkflow(workflow.id);
    if (latest) {
      latest.lastRunAt = now.toISOString();
      latest.updatedAt = now.toISOString();
      await store.saveScheduledWorkflow(latest);
    }
    if (error instanceof InputError) throw error;
    throw new InputError(run.error);
  }
}

export async function runWorkflowNow(
  id: string,
  now = new Date(),
  createExecution: ExecutionFactory = createExecutionFromPlan,
): Promise<Execution> {
  return schedulerState.withScheduleLock(id, async () => {
    const workflow = await getWorkflow(id);
    await synchronizeRuns(id);
    if (await store.getActiveScheduledWorkflowRun(id)) {
      throw new InputError("This workflow already has an active execution.");
    }
    const run = newRun(workflow, `manual:${randomUUID()}`, now.toISOString(), now, "claimed");
    const claim = await store.claimScheduledWorkflowRun(run);
    if (!claim.claimed) throw new InputError("This workflow already has an active execution.");
    const execution = await launchClaimedRun(workflow, run, now, createExecution);
    if (!execution) throw new InputError("The workflow execution could not be created.");
    return execution;
  });
}

async function synchronizeRuns(workflowId?: string): Promise<void> {
  const activeRuns = await store.listScheduledWorkflowRuns(workflowId, 500, true);
  for (const run of activeRuns) {
    if (!run.executionId) continue;
    const execution = await store.getExecution(run.executionId);
    if (!execution) {
      if (run.status === "running") {
        run.status = "failed";
        run.error = "The execution record is missing; the workflow was not retried.";
        run.completedAt = new Date().toISOString();
        await store.saveScheduledWorkflowRun(run);
      }
      continue;
    }
    run.status = statusFromExecution(execution);
    run.startedAt = execution.startedAt ?? execution.createdAt;
    run.completedAt = execution.completedAt;
    run.error = execution.error;
    await store.saveScheduledWorkflowRun(run);
  }
}

async function processDueWorkflow(
  id: string,
  now: Date,
  createExecution: ExecutionFactory,
): Promise<void> {
  await schedulerState.withScheduleLock(id, async () => {
    const workflow = await store.getScheduledWorkflow(id);
    if (!workflow || workflow.status !== "active" || !workflow.nextRunAt) return;
    const occurrenceAt = new Date(workflow.nextRunAt);
    if (!Number.isFinite(occurrenceAt.getTime()) || occurrenceAt.getTime() > now.getTime()) return;

    const missed = now.getTime() - occurrenceAt.getTime() > MISSED_RUN_GRACE_MS;
    if (missed) {
      await recordSkipped(
        workflow,
        occurrenceAt,
        now,
        "Missed while the scheduler was unavailable; overdue occurrences are not backfilled.",
      );
      await advanceSchedule(workflow, occurrenceAt, now, true);
      return;
    }

    const active = await store.getActiveScheduledWorkflowRun(id);
    if (active) {
      await recordSkipped(workflow, occurrenceAt, now, "Skipped because this workflow already has an active execution.");
      await advanceSchedule(workflow, occurrenceAt, now, true);
      return;
    }

    const run = newRun(workflow, occurrenceAt.toISOString(), occurrenceAt.toISOString(), now, "claimed");
    const claim = await store.claimScheduledWorkflowRun(run);
    if (!claim.claimed) {
      if (claim.run.occurrenceKey !== run.occurrenceKey) {
        await recordSkipped(workflow, occurrenceAt, now, "Skipped because this workflow already has an active execution.");
      }
      await advanceSchedule(workflow, occurrenceAt, now, false);
      return;
    }

    await advanceSchedule(workflow, occurrenceAt, now, false);
    await launchClaimedRun(workflow, run, now, createExecution);
  });
}

export async function runScheduledWorkflowTick(
  now = new Date(),
  createExecution: ExecutionFactory = createExecutionFromPlan,
): Promise<void> {
  await recoverScheduledWorkflowRuns(now, createExecution);
  await synchronizeRuns();
  const due = (await store.listScheduledWorkflows()).filter(
    (workflow) => workflow.status === "active" && workflow.nextRunAt && new Date(workflow.nextRunAt).getTime() <= now.getTime(),
  );
  for (const workflow of due) {
    try {
      await processDueWorkflow(workflow.id, now, createExecution);
    } catch (error) {
      console.error("[opencrewbot] Scheduled workflow occurrence failed.", error);
    }
  }
}

export async function recoverScheduledWorkflowRuns(
  now = new Date(),
  createExecution: ExecutionFactory = createExecutionFromPlan,
): Promise<void> {
  const activeRuns = await store.listScheduledWorkflowRuns(undefined, 500, true);
  for (const snapshot of activeRuns) {
    await schedulerState.withScheduleLock(snapshot.workflowId, async () => {
      const run = await store.getActiveScheduledWorkflowRun(snapshot.workflowId);
      if (!run || run.id !== snapshot.id) return;
      const execution = run.executionId ? await store.getExecution(run.executionId) : null;
      if (execution) {
        run.status = statusFromExecution(execution);
        run.startedAt = execution.startedAt ?? execution.createdAt;
        run.completedAt = execution.completedAt;
        run.error = execution.error;
        await store.saveScheduledWorkflowRun(run);
        const workflow = await store.getScheduledWorkflow(run.workflowId);
        if (workflow) {
          const executionAt = execution.startedAt ?? execution.createdAt;
          const executionTime = Date.parse(executionAt);
          const previousRunTime = workflow.lastRunAt ? Date.parse(workflow.lastRunAt) : Number.NaN;
          if (Number.isFinite(executionTime) && (!Number.isFinite(previousRunTime) || previousRunTime < executionTime)) {
            workflow.lastRunAt = executionAt;
            workflow.lastExecutionId = execution.id;
            workflow.updatedAt = now.toISOString();
            await store.saveScheduledWorkflow(workflow);
          }
        }
        return;
      }
      if (run.status === "running") {
        run.status = "failed";
        run.error = "The execution record is missing after restart; it was not retried.";
        run.completedAt = now.toISOString();
        await store.saveScheduledWorkflowRun(run);
        return;
      }
      const workflow = await store.getScheduledWorkflow(run.workflowId);
      if (!workflow) {
        run.status = "failed";
        run.error = "The saved workflow is unavailable after restart.";
        run.completedAt = now.toISOString();
        await store.saveScheduledWorkflowRun(run);
        return;
      }
      if (run.occurrenceKey === run.scheduledFor) {
        const occurrenceAt = new Date(run.scheduledFor);
        if (Number.isFinite(occurrenceAt.getTime()) && now.getTime() - occurrenceAt.getTime() > MISSED_RUN_GRACE_MS) {
          run.status = "skipped";
          run.error = "Missed while the scheduler was unavailable; overdue occurrences are not backfilled.";
          run.completedAt = now.toISOString();
          await store.saveScheduledWorkflowRun(run);
          if (workflow.nextRunAt === run.scheduledFor) {
            await advanceSchedule(workflow, occurrenceAt, now, true);
          }
          return;
        }
      }
      await launchClaimedRun(workflow, run, now, createExecution);
    });
  }
}

export function startScheduledWorkflowScheduler(): void {
  if (schedulerState.timer) return;
  const tick = () => {
    if (schedulerState.tick) return;
    schedulerState.tick = runScheduledWorkflowTick().finally(() => {
      schedulerState.tick = undefined;
    });
    void schedulerState.tick.catch((error) => console.error("[opencrewbot] Scheduled workflow polling failed.", error));
  };
  schedulerState.timer = setInterval(tick, SCHEDULER_INTERVAL_MS);
  schedulerState.timer.unref?.();
  tick();
}
