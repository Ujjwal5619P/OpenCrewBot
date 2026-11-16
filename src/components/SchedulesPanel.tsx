"use client";

import clsx from "clsx";
import { CalendarClock, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { timeLabel } from "@/lib/client/format";
import type { ScheduleRecurrence, ScheduleRun, ScheduledWorkflow } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button, Drawer, Field, inputClass } from "./ui";

function localDatetimeDefault(minutesFromNow = 5): string {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return localDatetimeDefault(5);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchedulesPanel({ onClose }: { onClose: () => void }) {
  const { state, open, toast } = useApp();
  const [schedules, setSchedules] = useState<ScheduledWorkflow[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Edit state for an existing schedule
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editRecurrence, setEditRecurrence] = useState<ScheduleRecurrence>("daily");
  const [editIntervalMinutes, setEditIntervalMinutes] = useState("60");
  const [editNextRunLocal, setEditNextRunLocal] = useState("");
  const [editMaxRetries, setEditMaxRetries] = useState("2");
  const [savingEdit, setSavingEdit] = useState(false);

  const defaultTarget = state.rooms[0] ? `room:${state.rooms[0].id}` : state.bots[0] ? `dm:${state.bots[0].id}` : "";
  const [name, setName] = useState("");
  const [targetKey, setTargetKey] = useState(defaultTarget);
  const [prompt, setPrompt] = useState("");
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>("daily");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [nextRunLocal, setNextRunLocal] = useState(() => localDatetimeDefault(5));
  const [maxRetries, setMaxRetries] = useState("2");

  const load = useCallback(async () => {
    try {
      const data = await api.schedules();
      setSchedules(data.schedules);
      setRuns(data.runs);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load schedules.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    api
      .schedules()
      .then((data) => {
        if (cancelled) return;
        setSchedules(data.schedules);
        setRuns(data.runs);
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof Error ? error.message : "Couldn't load schedules.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, state.schedulesVersion]);

  const targetValue = targetKey || defaultTarget;

  const create = async () => {
    const [kind, id] = targetValue.split(":");
    if (!id || !name.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      await api.createSchedule({
        name: name.trim(),
        target: kind === "room" ? { kind: "room", roomId: id } : { kind: "dm", botId: id },
        prompt: prompt.trim(),
        recurrence,
        intervalMinutes: recurrence === "interval" ? Math.max(1, Number(intervalMinutes) || 60) : undefined,
        nextRunAt: new Date(nextRunLocal).toISOString(),
        maxRetries: Math.min(5, Math.max(0, Number(maxRetries) || 0)),
        enabled: true,
      });
      setName("");
      setPrompt("");
      toast("Scheduled workflow saved.");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't create schedule.");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (s: ScheduledWorkflow) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditPrompt(s.prompt);
    setEditRecurrence(s.recurrence);
    setEditIntervalMinutes(String(s.intervalMinutes ?? 60));
    setEditNextRunLocal(toLocalInput(s.nextRunAt));
    setEditMaxRetries(String(s.maxRetries ?? 2));
  };

  const saveEdit = async (id: string) => {
    if (!editName.trim() || !editPrompt.trim()) return;
    setSavingEdit(true);
    try {
      await api.updateSchedule(id, {
        name: editName.trim(),
        prompt: editPrompt.trim(),
        recurrence: editRecurrence,
        intervalMinutes: editRecurrence === "interval" ? Math.max(1, Number(editIntervalMinutes) || 60) : undefined,
        nextRunAt: new Date(editNextRunLocal).toISOString(),
        maxRetries: Math.min(5, Math.max(0, Number(editMaxRetries) || 0)),
      });
      setEditingId(null);
      toast("Schedule updated.");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't update schedule.");
    } finally {
      setSavingEdit(false);
    }
  };

  const runNow = async (s: ScheduledWorkflow) => {
    setRunningId(s.id);
    try {
      const { run } = await api.runSchedule(s.id);
      toast(run.status === "success" ? `${s.name} completed.` : `${s.name} failed: ${run.error ?? "unknown error"}`);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't execute schedule.");
    } finally {
      setRunningId(null);
    }
  };

  const toggle = async (s: ScheduledWorkflow) => {
    try {
      await api.updateSchedule(s.id, { enabled: !s.enabled });
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't update schedule.");
    }
  };

  const remove = async (s: ScheduledWorkflow) => {
    try {
      await api.deleteSchedule(s.id);
      setConfirmDeleteId(null);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete schedule.");
    }
  };

  const targetLabel = (s: ScheduledWorkflow) =>
    s.target.kind === "room"
      ? `Room: ${state.rooms.find((r) => r.id === (s.target as { roomId: string }).roomId)?.name ?? "Unknown"}`
      : `Bot: ${state.bots.find((b) => b.id === (s.target as { botId: string }).botId)?.name ?? "Unknown"}`;

  return (
    <Drawer title="Scheduled workflows" onClose={onClose}>
      <p className="rounded-2xl bg-raised px-3.5 py-2.5 text-[12.5px] leading-relaxed text-mute">
        Schedules and run history persist in SQLite. Automatic ticks run in-process while the server process is active; missed runs catch up when the server starts.
      </p>

      <section className="mt-5 space-y-3 rounded-2xl bg-raised p-4">
        <h3 className="flex items-center gap-1.5 text-[13.5px] font-medium">
          <CalendarClock size={14} /> New scheduled workflow
        </h3>
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily competitor pricing scan" />
        </Field>
        <Field label="Target bot or room">
          <select className={clsx(inputClass, "appearance-none")} value={targetValue} onChange={(e) => setTargetKey(e.target.value)}>
            {state.rooms.map((r) => (
              <option key={`room:${r.id}`} value={`room:${r.id}`}>
                Room: {r.name}
              </option>
            ))}
            {state.bots.map((b) => (
              <option key={`dm:${b.id}`} value={`dm:${b.id}`}>
                Bot: {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Workflow prompt">
          <textarea
            className={clsx(inputClass, "min-h-20 resize-y")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="@scout Review top competitor updates and @ops record a brief status summary."
          />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Recurrence">
            <select
              className={clsx(inputClass, "appearance-none")}
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as ScheduleRecurrence)}
            >
              <option value="once">Once</option>
              <option value="interval">Every N minutes</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          <Field label="Max retries">
            <input type="number" min={0} max={5} className={inputClass} value={maxRetries} onChange={(e) => setMaxRetries(e.target.value)} />
          </Field>
        </div>
        {recurrence === "interval" && (
          <Field label="Interval (minutes)">
            <input type="number" min={1} max={10080} className={inputClass} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} />
          </Field>
        )}
        <Field label="Next run time (local)">
          <input type="datetime-local" className={inputClass} value={nextRunLocal} onChange={(e) => setNextRunLocal(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" disabled={saving || !name.trim() || !prompt.trim() || !targetValue} onClick={create}>
            {saving ? "Saving…" : "Create schedule"}
          </Button>
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[12.5px] font-medium text-mute">Schedules ({schedules.length})</h3>
          <button onClick={() => void load()} className="inline-flex items-center gap-1 text-[12px] text-faint hover:text-ink">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {loading && <p className="rounded-2xl bg-raised px-4 py-4 text-[13px] text-mute">Loading…</p>}
        {!loading && schedules.length === 0 && (
          <p className="rounded-2xl bg-raised px-4 py-4 text-[13px] text-mute">No scheduled workflows yet.</p>
        )}
        {schedules.length > 0 && (
          <ul className="divide-y divide-line rounded-2xl bg-raised">
            {schedules.map((s) => (
              <li key={s.id} className="space-y-2 px-4 py-3.5">
                {editingId === s.id ? (
                  <div className="space-y-2.5">
                    <Field label="Name">
                      <input className={inputClass} value={editName} onChange={(e) => setEditName(e.target.value)} />
                    </Field>
                    <Field label="Workflow prompt">
                      <textarea className={clsx(inputClass, "min-h-20 resize-y")} value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Recurrence">
                        <select
                          className={clsx(inputClass, "appearance-none")}
                          value={editRecurrence}
                          onChange={(e) => setEditRecurrence(e.target.value as ScheduleRecurrence)}
                        >
                          <option value="once">Once</option>
                          <option value="interval">Every N minutes</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                        </select>
                      </Field>
                      <Field label="Max retries">
                        <input type="number" min={0} max={5} className={inputClass} value={editMaxRetries} onChange={(e) => setEditMaxRetries(e.target.value)} />
                      </Field>
                    </div>
                    {editRecurrence === "interval" && (
                      <Field label="Interval (minutes)">
                        <input type="number" min={1} max={10080} className={inputClass} value={editIntervalMinutes} onChange={(e) => setEditIntervalMinutes(e.target.value)} />
                      </Field>
                    )}
                    <Field label="Next run time (local)">
                      <input type="datetime-local" className={inputClass} value={editNextRunLocal} onChange={(e) => setEditNextRunLocal(e.target.value)} />
                    </Field>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" disabled={savingEdit || !editName.trim() || !editPrompt.trim()} onClick={() => void saveEdit(s.id)}>
                        {savingEdit ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium">{s.name}</p>
                        <p className="text-[12px] text-mute">
                          {targetLabel(s)} · {s.recurrence === "interval" ? `every ${s.intervalMinutes ?? 60}m` : s.recurrence}
                        </p>
                      </div>
                      <span
                        className={clsx(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          !s.enabled
                            ? "bg-raised-2 text-faint"
                            : s.lastStatus === "failed"
                              ? "bg-danger-soft text-danger"
                              : s.lastStatus === "success"
                                ? "bg-ok/15 text-ok"
                                : "bg-accent-soft text-[#8db4ff]",
                        )}
                      >
                        {!s.enabled ? "Paused" : s.lastStatus ?? "Scheduled"}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-[12.5px] text-mute">{s.prompt}</p>
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
                      <span>Next: {new Date(s.nextRunAt).toLocaleString()}</span>
                      <span>Retries: {s.maxRetries}</span>
                      {s.retryCount > 0 && <span className="text-warn">Retry {s.retryCount}/{s.maxRetries}</span>}
                    </div>
                    {s.lastError && <p className="rounded-xl bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">{s.lastError}</p>}
                    {confirmDeleteId === s.id ? (
                      <div className="flex items-center justify-between gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[12px]">
                        <span className="text-danger">Delete &quot;{s.name}&quot; and history?</span>
                        <span className="flex gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void remove(s)}>
                            Confirm delete
                          </Button>
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 pt-1">
                        <Button size="sm" variant="secondary" disabled={runningId === s.id} onClick={() => void runNow(s)}>
                          {runningId === s.id ? "Running…" : "Run now"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void toggle(s)}>
                          {s.enabled ? (
                            <>
                              <Pause size={12} /> Pause
                            </>
                          ) : (
                            <>
                              <Play size={12} /> Resume
                            </>
                          )}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => startEdit(s)}>
                          <Pencil size={12} /> Edit
                        </Button>
                        <button
                          aria-label={`Delete ${s.name}`}
                          onClick={() => setConfirmDeleteId(s.id)}
                          className="ml-auto rounded-full p-1.5 text-faint hover:bg-raised-2 hover:text-danger"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-[12.5px] font-medium text-mute">Recent execution history ({runs.length})</h3>
        {runs.length === 0 ? (
          <p className="rounded-2xl bg-raised px-4 py-4 text-[13px] text-mute">No executions recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-2xl bg-raised">
            {runs.slice(0, 15).map((r) => (
              <li key={r.id} className="space-y-1 px-4 py-3 text-[12.5px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{r.scheduleName}</span>
                  <span className={clsx("text-[11.5px] font-medium", r.status === "success" ? "text-ok" : r.status === "failed" ? "text-danger" : "text-warn")}>
                    {r.status}
                    {r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11.5px] text-faint">
                  <span>
                    {timeLabel(r.startedAt)}
                    {r.simulated ? " · simulated" : ""}
                    {r.willRetry ? " · retry queued" : ""}
                  </span>
                  <button
                    onClick={() => {
                      open(r.conversationId);
                      onClose();
                    }}
                    className="text-[#8db4ff] hover:underline"
                  >
                    Open chat
                  </button>
                </div>
                {r.error && <p className="text-[11.5px] text-danger">{r.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Drawer>
  );
}

