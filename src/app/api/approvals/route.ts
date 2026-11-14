import { handle } from "@/lib/server/http";
import { listApprovalRequests } from "@/lib/server/db";

export async function GET() {
  return handle(async () => ({ requests: await listApprovalRequests() }));
}
