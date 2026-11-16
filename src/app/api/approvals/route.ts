import { handle } from "@/lib/server/http";
import { listPendingApprovals } from "@/lib/server/runtime";
import { boot } from "@/lib/server/service";

export async function GET() {
  return handle(async () => {
    await boot();
    return { approvals: await listPendingApprovals() };
  });
}
