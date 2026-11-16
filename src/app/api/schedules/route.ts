import { connection } from "next/server";
import { body, handle } from "@/lib/server/http";
import { createSchedule, listAllSchedules, listRuns } from "@/lib/server/scheduler";
import type { ScheduleInput } from "@/lib/shared/types";

export async function GET() {
  await connection();
  return handle(async () => {
    const [schedules, runs] = await Promise.all([listAllSchedules(), listRuns(50)]);
    return { schedules, runs };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<ScheduleInput>(request);
    return { schedule: await createSchedule(input) };
  });
}
