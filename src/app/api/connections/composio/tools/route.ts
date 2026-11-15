import { handle } from "@/lib/server/http";
import { discoverAppTools } from "@/lib/server/composio";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return handle(async () => ({
    discovery: await discoverAppTools(params.get("slug") ?? "", params.get("query") ?? ""),
  }));
}
