import { handle } from "@/lib/server/http";
import { listRoomCollaboration } from "@/lib/server/collaboration";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(() => listRoomCollaboration(id));
}
