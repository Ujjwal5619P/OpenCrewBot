import { connection } from "next/server";
import { resolveAppStatus } from "@/lib/server/config";
import { listBots, listRooms } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { listModels } from "@/lib/server/models";
import { boot, summaries } from "@/lib/server/service";
import { liveViews } from "@/lib/server/browserbase";

export async function GET() {
  await connection();
  return handle(async () => {
    await boot();
    const [status, bots, rooms, conversations, models] = await Promise.all([resolveAppStatus(), listBots(), listRooms(), summaries(), listModels()]);
    return { status, bots, rooms, conversations, models, liveViews: liveViews() };
  });
}
