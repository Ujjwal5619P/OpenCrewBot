import { body, handle } from "@/lib/server/http";
import { delegateInRoom } from "@/lib/server/rooms";

export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[id]/delegate">) {
  const { id } = await ctx.params;
  return handle(async () => {
    const payload = await body<unknown>(request);
    return { report: await delegateInRoom(id, null, payload) };
  });
}
