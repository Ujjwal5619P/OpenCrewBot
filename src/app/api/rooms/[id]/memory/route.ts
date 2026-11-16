import { publish } from "@/lib/server/bus";
import { getRoom } from "@/lib/server/db";
import { InputError } from "@/lib/server/errors";
import { body, handle } from "@/lib/server/http";
import { MEMORY_PROMPT_LIMIT, readRoomMemory, roomMemoryPath, writeRoomMemory } from "@/lib/server/memory-files";
import { boot } from "@/lib/server/service";

async function requireRoom(id: string) {
  await boot();
  const room = await getRoom(id);
  if (!room) throw new InputError("That room doesn't exist.");
  return room;
}

export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[id]/memory">) {
  const { id } = await ctx.params;
  return handle(async () => {
    await requireRoom(id);
    return { content: readRoomMemory(id), path: roomMemoryPath(id), limit: MEMORY_PROMPT_LIMIT };
  });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/rooms/[id]/memory">) {
  const { id } = await ctx.params;
  return handle(async () => {
    await requireRoom(id);
    const { content } = await body<{ content: string }>(request);
    if (typeof content !== "string") throw new InputError("Expected { content }.");
    const saved = writeRoomMemory(id, content);
    publish({ type: "room-memory-changed", roomId: id });
    return { content: saved };
  });
}
