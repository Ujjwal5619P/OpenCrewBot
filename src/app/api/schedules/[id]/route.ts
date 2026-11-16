import { body, handle } from "@/lib/server/http";
import { deleteSchedule, updateSchedule } from "@/lib/server/scheduler";
import type { ScheduledWorkflow } from "@/lib/shared/types";

export async function PATCH(request: Request, ctx: RouteContext<"/api/schedules/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const patch = await body<Partial<ScheduledWorkflow>>(request);
    return { schedule: await updateSchedule(id, patch) };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/schedules/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => {
    await deleteSchedule(id);
  });
}
