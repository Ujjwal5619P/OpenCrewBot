import type { ScheduledWorkflow, WorkflowRecurrence } from "@/lib/shared/types";

export interface ScheduleTiming {
  recurrence: WorkflowRecurrence;
  timeZone: string;
  localTime: string;
  oneTimeLocal?: string;
  weekdays: number[];
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(date: Date, timeZone: string): ZonedParts & { weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    weekday: WEEKDAY_INDEX[values.get("weekday") ?? ""] ?? 0,
  };
}

function validDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const dateValue = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  return (
    dateValue.getUTCFullYear() === Number(yearText) &&
    dateValue.getUTCMonth() === Number(monthText) - 1 &&
    dateValue.getUTCDate() === Number(dayText)
  );
}

function localDateTimeToUtc(localDate: string, localTime: string, timeZone: string): Date | null {
  if (!validDate(localDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) return null;
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();

  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = new Date(wallClockAsUtc + hours * 60 * 60 * 1000);
    const local = zonedParts(probe, timeZone);
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const probeAtMinute = Math.floor(probe.getTime() / 60_000) * 60_000;
    offsets.add(representedAsUtc - probeAtMinute);
  }

  const candidates = [...offsets]
    .map((offset) => new Date(wallClockAsUtc - offset))
    .filter((candidate) => {
      const local = zonedParts(candidate, timeZone);
      return (
        local.year === year &&
        local.month === month &&
        local.day === day &&
        local.hour === hour &&
        local.minute === minute
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());

  // During a fall-back overlap, choose the earlier occurrence. A nonexistent
  // wall time during a spring-forward gap returns null and is skipped.
  return candidates[0] ?? null;
}

export function zonedLocalDateTimeToUtc(localDateTime: string, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):[0-5]\d)$/.exec(localDateTime);
  if (!match) return null;
  return localDateTimeToUtc(match[1], match[2], timeZone);
}

function dateAfter(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear().toString().padStart(4, "0")}-${(result.getUTCMonth() + 1).toString().padStart(2, "0")}-${result
    .getUTCDate()
    .toString()
    .padStart(2, "0")}`;
}

function localDateString(parts: ZonedParts): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function nextScheduledOccurrence(timing: ScheduleTiming, after: Date): Date | null {
  if (timing.recurrence === "once") {
    if (!timing.oneTimeLocal) return null;
    const candidate = zonedLocalDateTimeToUtc(timing.oneTimeLocal, timing.timeZone);
    return candidate && candidate.getTime() > after.getTime() ? candidate : null;
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.localTime)) return null;
  const currentLocal = zonedParts(after, timing.timeZone);
  const currentDate = localDateString(currentLocal);
  const limit = timing.recurrence === "daily" ? 4 : 15;
  for (let offset = 0; offset < limit; offset += 1) {
    const targetDate = dateAfter(currentDate, offset);
    const [year, month, day] = targetDate.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (timing.recurrence === "weekly" && !timing.weekdays.includes(weekday)) continue;
    const candidate = localDateTimeToUtc(targetDate, timing.localTime, timing.timeZone);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

export function nextWorkflowRun(workflow: Pick<ScheduledWorkflow, "recurrence" | "timeZone" | "localTime" | "oneTimeLocal" | "weekdays">, after: Date): Date | null {
  return nextScheduledOccurrence(workflow, after);
}
