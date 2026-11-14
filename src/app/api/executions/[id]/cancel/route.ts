import { handle } from "@/lib/server/http";
import { cancelExecution } from "@/lib/server/execution-service";

export async function POST(_request: Request, ctx: RouteContext<"/api/executions/[id]/cancel">) {
  const { id } = await ctx.params;
  return handle(async () => ({ execution: await cancelExecution(id) }));
}
