import { handle } from "@/lib/server/http";
import { getExecution } from "@/lib/server/execution-service";

export async function GET(_request: Request, ctx: RouteContext<"/api/executions/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => ({ execution: await getExecution(id) }));
}
