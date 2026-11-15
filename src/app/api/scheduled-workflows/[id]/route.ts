import { body, handle } from "@/lib/server/http";
import { deleteWorkflow, updateWorkflow } from "@/lib/server/scheduled-workflows";
import { InputError } from "@/lib/server/errors";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => {
    const payload = await body<unknown>(request);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new InputError("Expected a scheduled workflow object.");
    }
    return { workflow: await updateWorkflow(id, payload) };
  });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async () => ({ workflow: await deleteWorkflow(id) }));
}
