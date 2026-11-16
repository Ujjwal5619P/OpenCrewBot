import { listDelegationRuns } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { boot } from "@/lib/server/service";

export async function GET(request: Request) {
  return handle(async () => {
    await boot();
    const url = new URL(request.url);
    const roomId = url.searchParams.get("roomId") || undefined;
    return { runs: await listDelegationRuns(roomId) };
  });
}
