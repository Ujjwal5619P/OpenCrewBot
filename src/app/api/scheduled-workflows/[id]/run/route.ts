import { handle } from "@/lib/server/http";
import { runWorkflowNow } from "@/lib/server/scheduled-workflows";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => ({ execution: await runWorkflowNow(id) }));
}
