import { conversationParam, body, handle } from "@/lib/server/http";
import { InputError } from "@/lib/server/errors";
import { respondToApproval } from "@/lib/server/runtime";

export async function POST(request: Request, ctx: RouteContext<"/api/conversations/[id]/approval">) {
  const id = conversationParam((await ctx.params).id);
  return handle(async () => {
    const value = await body<unknown>(request);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).botId !== "string" ||
      typeof (value as Record<string, unknown>).toolCallId !== "string" ||
      typeof (value as Record<string, unknown>).approve !== "boolean"
    ) {
      throw new InputError("Expected { botId: string, toolCallId: string, approve: boolean }.");
    }
    const { botId, toolCallId, approve } = value as { botId: string; toolCallId: string; approve: boolean };
    await respondToApproval(id, botId, toolCallId, approve);
    return { ok: true };
  });
}
