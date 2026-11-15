"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ScheduledWorkflowDraft } from "@/lib/client/api";
import type { ScheduledWorkflow, ScheduledWorkflowRun, WorkflowRecurrence } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button, Field, inputClass } from "./ui";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function blankDraft(): ScheduledWorkflowDraft {
  return {
    name: "",
    instruction: "",
    recurrence: "once",
    timeZone: "UTC",
    oneTimeLocal: "",
    localTime: "09:00",
    weekdays: [1],
  };
}

function displayTime(value: string | null | undefined, timeZone: string): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function runStatusLabel(status: ScheduledWorkflowRun["status"]): string {
  return status === "outcome_unknown" ? "Outcome unknown" : status.replaceAll("_", " ");
}

export function ScheduledWorkflows() {
  const { state, toast } = useApp();
  const [workflows, setWorkflows] = useState<ScheduledWorkflow[]>([]);
  const [runs, setRuns] = useState<ScheduledWorkflowRun[]>([]);
  const [workflowHistory, setWorkflowHistory] = useState<Record<string, ScheduledWorkflowRun[]>>({});
  const [historyHasMore, setHistoryHasMore] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<ScheduledWorkflowDraft>(blankDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.scheduledWorkflows();
      setWorkflows(result.workflows);
      setRuns(result.runs);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load scheduled workflows.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadWorkflowHistory = useCallback(async (workflowId: string, append: boolean) => {
    setHistoryLoading((current) => ({ ...current, [workflowId]: true }));
    try {
      const offset = append ? workflowHistory[workflowId]?.length ?? 0 : 0;
      const result = await api.scheduledWorkflows({ workflowId, limit: 8, offset });
      setWorkflowHistory((current) => ({
        ...current,
        [workflowId]: append ? [...(current[workflowId] ?? []), ...result.runs] : result.runs,
      }));
      setHistoryHasMore((current) => ({ ...current, [workflowId]: result.pagination?.hasMore ?? false }));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load workflow execution history.");
    } finally {
      setHistoryLoading((current) => ({ ...current, [workflowId]: false }));
    }
  }, [toast, workflowHistory]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTimeZone) setDraft((current) => ({ ...current, timeZone: browserTimeZone }));
      void refresh();
    }, 0);
    const timer = window.setInterval(() => void refresh(), 7_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const resetForm = () => {
    setDraft({ ...blankDraft(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
    setEditingId(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save");
    try {
      if (editingId) await api.updateScheduledWorkflow(editingId, draft);
      else await api.createScheduledWorkflow(draft);
      toast(editingId ? "Scheduled workflow updated." : "Scheduled workflow created.");
      resetForm();
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save the scheduled workflow.");
    } finally {
      setBusy(null);
    }
  };

  const edit = (workflow: ScheduledWorkflow) => {
    setEditingId(workflow.id);
    setDraft({
      name: workflow.name,
      instruction: workflow.plan.instruction,
      recurrence: workflow.recurrence,
      timeZone: workflow.timeZone,
      localTime: workflow.localTime,
      oneTimeLocal: workflow.oneTimeLocal ?? "",
      weekdays: workflow.weekdays,
    });
  };

  const perform = async (workflow: ScheduledWorkflow, action: "pause" | "resume" | "run" | "delete") => {
    setBusy(workflow.id);
    try {
      if (action === "pause") await api.pauseScheduledWorkflow(workflow.id);
      if (action === "resume") await api.resumeScheduledWorkflow(workflow.id);
      if (action === "run") await api.runScheduledWorkflow(workflow.id);
      if (action === "delete") await api.deleteScheduledWorkflow(workflow.id);
      toast(
        action === "run"
          ? "Manual execution started."
          : action === "delete"
            ? "Workflow deleted."
            : `Workflow ${action === "pause" ? "paused" : "resumed"}.`,
      );
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : `Couldn't ${action} the workflow.`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const changeRecurrence = (recurrence: WorkflowRecurrence) => {
    setDraft((current) => ({ ...current, recurrence }));
  };
  const toggleWeekday = (weekday: number) => {
    setDraft((current) => {
      const weekdays = current.weekdays ?? [];
      return {
        ...current,
        weekdays: weekdays.includes(weekday) ? weekdays.filter((day) => day !== weekday) : [...weekdays, weekday].sort(),
      };
    });
  };

  return (
    <section className="mt-7">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-medium text-mute">Scheduled workflows</h3>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-mute">
        Save a planned workflow and run it on a one-time, daily, or weekly schedule. Each run uses the saved task plan and current agent permissions.
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-faint">
        Missed runs more than five minutes late are skipped; overlaps are skipped. The scheduler assumes one active application server.
        Pausing stops future runs but does not cancel an active execution. Approval requests still pause tasks for human review.
      </p>

      <form className="mt-3 space-y-3 rounded-2xl bg-raised p-3.5" onSubmit={(event) => void save(event)}>
        <Field label="Workflow name">
          <input
            className={inputClass}
            required
            maxLength={80}
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Weekly product research"
          />
        </Field>
        <Field label="Instruction" hint="The task plan is created once and reused for each run. Changing this instruction replans the workflow.">
          <textarea
            className={`${inputClass} min-h-20 resize-y`}
            required
            maxLength={20_000}
            value={draft.instruction}
            onChange={(event) => setDraft((current) => ({ ...current, instruction: event.target.value }))}
            placeholder="Research the latest developments and prepare a concise brief."
          />
        </Field>
        <Field label="Schedule">
          <select
            className={inputClass}
            value={draft.recurrence}
            onChange={(event) => changeRecurrence(event.target.value as WorkflowRecurrence)}
          >
            <option value="once">One time</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        {draft.recurrence === "once" ? (
          <Field label="Local date and time">
            <input
              className={inputClass}
              type="datetime-local"
              required
              value={draft.oneTimeLocal ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, oneTimeLocal: event.target.value }))}
            />
          </Field>
        ) : (
          <>
            <Field label="Local time">
              <input
                className={inputClass}
                type="time"
                required
                value={draft.localTime ?? "09:00"}
                onChange={(event) => setDraft((current) => ({ ...current, localTime: event.target.value }))}
              />
            </Field>
            {draft.recurrence === "weekly" && (
              <fieldset>
                <legend className="mb-1.5 text-[12.5px] font-medium text-mute">Weekdays</legend>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((day, index) => {
                    const selected = (draft.weekdays ?? []).includes(index);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleWeekday(index)}
                        className={`rounded-full px-2.5 py-1 text-[11px] ${selected ? "bg-accent-soft text-ink ring-1 ring-accent/60" : "bg-raised-2 text-mute"}`}
                      >
                        {day.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </>
        )}
        <Field label="IANA timezone" hint="Wall-clock times use this timezone. For a DST clock gap, that day's occurrence is skipped.">
          <input
            className={inputClass}
            required
            maxLength={100}
            value={draft.timeZone}
            onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
            placeholder="America/New_York"
          />
        </Field>
        <div className="flex justify-end gap-2">
          {editingId && (
            <Button type="button" onClick={resetForm}>
              Cancel edit
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : editingId ? "Save changes" : "Create workflow"}
          </Button>
        </div>
      </form>

      <div className="mt-3 space-y-2">
        {loading && workflows.length === 0 && <p className="text-[13px] text-mute">Loading workflows…</p>}
        {!loading && workflows.length === 0 && <p className="text-[13px] text-mute">No scheduled workflows yet.</p>}
        {workflows.map((workflow) => {
          const workflowRuns = workflowHistory[workflow.id] ?? [];
          const latestRun = runs.find((run) => run.workflowId === workflow.id);
          return (
            <article key={workflow.id} className="rounded-2xl bg-raised px-3.5 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium">{workflow.name}</p>
                  <p className="mt-0.5 text-[11px] text-mute">
                    {workflow.recurrence === "once"
                      ? "One time"
                      : workflow.recurrence === "daily"
                        ? `Daily at ${workflow.localTime}`
                        : `Weekly ${workflow.weekdays.map((day) => WEEKDAYS[day].slice(0, 3)).join(", ")} at ${workflow.localTime}`}
                    {" · "}{workflow.timeZone}
                  </p>
                </div>
                <span className={`shrink-0 text-[11px] capitalize ${workflow.status === "active" ? "text-ok" : "text-faint"}`}>
                  {workflow.status}
                </span>
              </div>
              <p className="mt-2 text-[12px] text-mute">Next run: {displayTime(workflow.nextRunAt, workflow.timeZone)}</p>
              <p className="mt-0.5 text-[12px] text-mute">Last run: {displayTime(workflow.lastRunAt, workflow.timeZone)}</p>
              <p className="mt-0.5 text-[12px] capitalize text-faint">
                Latest status: {latestRun ? runStatusLabel(latestRun.status) : "not run"}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-mute">{workflow.plan.summary}</p>
              <p className="mt-1 text-[11px] text-faint">
                {workflow.plan.plannerLabel} · {workflow.plan.tasks.length} tasks
              </p>
              <ul className="mt-1 space-y-0.5 text-[11px] text-faint">
                {workflow.plan.tasks.slice(0, 4).map((task) => (
                  <li key={task.id} className="truncate">
                    {task.title} · {state.bots.find((bot) => bot.id === task.assignedBotId)?.name ?? "Unavailable agent"}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap justify-end gap-1">
                {workflow.status !== "completed" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void perform(workflow, workflow.status === "paused" ? "resume" : "pause")}
                  >
                    {workflow.status === "paused" ? "Resume" : "Pause"}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => edit(workflow)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void perform(workflow, "run")}>
                  Run now
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Delete "${workflow.name}"?`)) void perform(workflow, "delete");
                  }}
                >
                  Delete
                </Button>
              </div>
              {(latestRun || workflowRuns.length > 0) && (
                <details className="mt-2 border-t border-line pt-2" onToggle={(event) => {
                  if (event.currentTarget.open && workflowHistory[workflow.id] === undefined && !historyLoading[workflow.id]) {
                    void loadWorkflowHistory(workflow.id, false);
                  }
                }}>
                  <summary className="cursor-pointer text-[11px] text-mute">Execution history</summary>
                  <div className="mt-2 space-y-2">
                    {workflowRuns.slice(0, 8).map((run) => (
                      <div key={run.id} className="rounded-xl bg-raised-2 px-2.5 py-2 text-[11px]">
                        <div className="flex justify-between gap-2">
                          <span className="capitalize">{runStatusLabel(run.status)}</span>
                          <span className="text-faint">{displayTime(run.scheduledFor, workflow.timeZone)}</span>
                        </div>
                        {run.executionId && <p className="mt-1 break-all text-faint">Execution {run.executionId}</p>}
                        {run.error && <p className="mt-1 whitespace-pre-wrap break-words text-danger">{run.error}</p>}
                      </div>
                    ))}
                    {historyHasMore[workflow.id] && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={historyLoading[workflow.id]}
                        onClick={() => void loadWorkflowHistory(workflow.id, true)}
                      >
                        {historyLoading[workflow.id] ? "Loading…" : "Load more"}
                      </Button>
                    )}
                    {historyLoading[workflow.id] && workflowRuns.length === 0 && (
                      <p className="text-[11px] text-mute">Loading execution history…</p>
                    )}
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
