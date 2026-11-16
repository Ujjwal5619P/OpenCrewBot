import { handle } from "@/lib/server/http";
import { executeSchedule } from "@/lib/server/scheduler";

export async function POST(_request: Request, ctx: RouteContext<"/api/schedules/[id]/run">) {
  const { id } = await ctx.params;
  return handle(async () => ({ run: await executeSchedule(id) }));
}
