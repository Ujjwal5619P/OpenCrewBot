import { connection } from "next/server";
import { appStatus } from "@/lib/server/config";
import { listBots, listRooms } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { listModelCatalog } from "@/lib/server/models";
import { summaries } from "@/lib/server/service";
import { liveViews } from "@/lib/server/browserbase";

export async function GET() {
  await connection();
  return handle(async () => {
    const [bots, rooms, conversations, catalog] = await Promise.all([listBots(), listRooms(), summaries(), listModelCatalog()]);
    const status = appStatus();
    status.mock = !catalog.providers.some((provider) => provider.available);
    return {
      status,
      bots,
      rooms,
      conversations,
      models: catalog.models,
      modelProviders: catalog.providers,
      liveViews: liveViews(),
    };
  });
}
